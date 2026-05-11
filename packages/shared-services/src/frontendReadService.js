"use strict";

const {
  activityAiReviewRepository,
  agentStateRepository,
  callLogRepository,
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  dailyCallStatRepository,
  deepCutRunRepository,
  dispatchListRepository,
  leadCadenceRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentAlertRepository,
  paymentLedgerRepository,
  qualityReviewRepository,
  reviewQueueRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { PORTS, getCompanyKeys, getRingCentralConfig } = require("../../shared-config/src");
const { legacyReadDb } = require("../../shared-repositories/src/legacyReadDb");
const { buildControlPlaneHealthReport, buildProviderHealth } = require("./controlPlaneHealthService");
const { buildContactLibraryCatalog } = require("./contactLibraryService");
const {
  buildLegacyCallrailWorkspace,
  buildLegacyDailySummaryWorkspace,
  buildLegacyMailCostWorkspace,
  buildLegacyMetricSourcesWorkspace,
  buildLegacyMetricsWorkspace,
  buildLegacyRedlineWorkspace,
} = require("./legacyMetricsService");
const {
  getLatestManualDailySummaryDate,
  listManualDailySummaryRows,
  listManualMetricSourceRows,
} = require("./metricsManualOverlayService");
const {
  listRoiEligiblePayments,
  resolveRoiPaymentSourceMeta,
  summarizeRoiPaymentsBySource,
} = require("./paymentRoiService");
const { listServiceTopology } = require("./serviceCatalog");
const { listSourceCanonicals } = require("./sourceCanonicalService");
const {
  mintRecordingPlaybackUrl,
} = require("./recordingPlaybackUrlService");
const { deriveFreshLeadGate } = require("./agentAvailabilityService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildLegacySpendDateMatch(filters = {}) {
  if (filters.date) {
    return { date: String(filters.date) };
  }

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return Object.keys(range).length > 0 ? { date: range } : {};
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacySpendFallbackEnabled() {
  return boolFromEnv(process.env.FRONTEND_LEGACY_SPEND_FALLBACK_ENABLED, false);
}

function legacyMetricsFallbackEnabled() {
  return boolFromEnv(process.env.FRONTEND_LEGACY_METRICS_FALLBACK_ENABLED, false);
}

// Legacy dailyspends fallback for metric views. Disabled by default now
// that raw dailyspends has been migrated into ControlPlaneSpendEntry.
async function listLegacySpendRows(domain, filters = {}) {
  if (!legacySpendFallbackEnabled()) return [];
  const mongoose = require("mongoose");
  const legacyDb = legacyReadDb(mongoose);
  return legacyDb.collection("dailyspends").aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        ...buildLegacySpendDateMatch(filters),
      },
    },
    {
      $group: {
        _id: { source: "$source", channel: "$channel" },
        spend: { $sum: { $ifNull: ["$spend", 0] } },
        pieces: { $sum: { $ifNull: ["$pieces", 0] } },
        impressions: { $sum: { $ifNull: ["$impressions", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
        leadsReported: { $sum: { $ifNull: ["$leadsReported", 0] } },
      },
    },
  ]).toArray().then((rows) =>
    rows.map((r) => ({
      source: r._id?.source || "Unknown",
      channel: r._id?.channel || null,
      spend: Number(r.spend || 0),
      pieces: Number(r.pieces || 0),
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      leadsReported: Number(r.leadsReported || 0),
    })),
  );
}

function todayIsoLA(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function toDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

const GLOBAL_METRICS_DOMAIN = "ALL";
const METRICS_ALIAS_DOMAIN = "METRICS";
const METRICS_ALL_TIME_START = "2024-01-01";

function isGlobalMetricsDomain(domain) {
  const normalized = normalizeDomain(domain);
  return !normalized || normalized === GLOBAL_METRICS_DOMAIN || normalized === METRICS_ALIAS_DOMAIN;
}

function listMetricsDomains() {
  return [...new Set(getCompanyKeys().map((value) => normalizeDomain(value)).filter(Boolean))];
}

function resolveMetricFamilyKey(channel, source = null) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const value = `${normalizedChannel} ${normalizedSource}`;

  if (
    normalizedChannel === "mailer" ||
    normalizedChannel === "mail" ||
    value.includes("direct mail")
  ) return "mail";
  if (
    normalizedChannel === "bcd" ||
    (normalizedChannel === "vendor" && value.includes("bcd")) ||
    value.includes("bcd")
  ) return "bcd";
  if (
    normalizedChannel === "ld" ||
    normalizedChannel === "ld-posting" ||
    normalizedChannel === "affiliate" ||
    normalizedChannel === "lead-distribution" ||
    normalizedChannel === "lead-data" ||
    value.includes("lead data") ||
    value.includes("lead post") ||
    value.includes("affiliate") ||
    value.includes("digital") ||
    value.includes("a+ leads")
  ) return "ld";
  if (
    normalizedChannel === "meta" ||
    normalizedChannel === "paid-social" ||
    normalizedChannel === "paid-search" ||
    normalizedChannel === "facebook" ||
    normalizedChannel === "instagram" ||
    normalizedChannel === "tiktok" ||
    normalizedChannel === "social" ||
    value.includes("vf meta") ||
    value.includes("meta") ||
    value.includes("facebook") ||
    value.includes("fb") ||
    value.includes("instagram") ||
    value.includes("tiktok")
  ) return "meta";
  if (
    normalizedChannel === "dialer" ||
    normalizedChannel === "callfire" ||
    value.includes("dialer") ||
    value.includes("callfire") ||
    value.includes("rvm transfer")
  ) return "dialer";

  return "other";
}

function normalizeMetricSourceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const METRIC_SOURCE_ROLLUP_OVERRIDES = new Map([
  [
    "affordability federal snap",
    { source: "Affordability Federal", channel: "mailer" },
  ],
  [
    "affordability federal snpa",
    { source: "Affordability Federal", channel: "mailer" },
  ],
  [
    "affordability pink state snap",
    { source: "Affordability Pink State", channel: "mailer" },
  ],
  [
    "aged data",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "callfire",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "hand dialer",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "citation state",
    { source: "Citation State PC", channel: "mailer" },
  ],
  [
    "yellow line dialer",
    { source: "CallFire", channel: "dialer" },
  ],
]);

function shouldReplaceMetricCanonicalMeta(currentMeta = null, nextMeta = null) {
  if (!nextMeta) return false;
  if (!currentMeta) return true;
  if (Boolean(currentMeta.active) !== Boolean(nextMeta.active)) {
    return Boolean(nextMeta.active);
  }
  return false;
}

function buildMetricSourceCanonicalLookup(sourceCanonicals = []) {
  const byInternal = new Map();
  const byAlias = new Map();

  for (const doc of sourceCanonicals) {
    if (!doc?.internalName) continue;
    const meta = {
      source: doc.internalName,
      channel: doc.channel || null,
      active: Boolean(doc.active),
    };
    const normalizedInternal = normalizeMetricSourceName(doc.internalName);
    if (normalizedInternal) {
      const currentInternal = byInternal.get(normalizedInternal);
      if (shouldReplaceMetricCanonicalMeta(currentInternal, meta)) {
        byInternal.set(normalizedInternal, meta);
      } else if (!currentInternal) {
        byInternal.set(normalizedInternal, meta);
      }
      const currentAlias = byAlias.get(normalizedInternal);
      if (shouldReplaceMetricCanonicalMeta(currentAlias, meta)) {
        byAlias.set(normalizedInternal, meta);
      } else if (!currentAlias) {
        byAlias.set(normalizedInternal, meta);
      }
    }
    const aliases = Array.isArray(doc.aliases) ? doc.aliases : [];
    for (const alias of aliases) {
      const text = normalizeMetricSourceName(alias);
      if (text) {
        const currentAlias = byAlias.get(text);
        if (shouldReplaceMetricCanonicalMeta(currentAlias, meta)) {
          byAlias.set(text, meta);
        } else if (!currentAlias) {
          byAlias.set(text, meta);
        }
      }
    }
  }

  return { byInternal, byAlias };
}

function applyMetricSourceRollupOverride(meta = {}, sourceName, fallbackChannel = null) {
  const candidates = [
    normalizeMetricSourceName(sourceName),
    normalizeMetricSourceName(meta?.source),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const override = METRIC_SOURCE_ROLLUP_OVERRIDES.get(candidate);
    if (!override) continue;
    return {
      source: override.source,
      channel: override.channel || meta?.channel || fallbackChannel || null,
      active: meta?.active ?? null,
    };
  }

  return {
    source: String(meta?.source || sourceName || "Unknown"),
    channel: meta?.channel || fallbackChannel || null,
    active: meta?.active ?? null,
  };
}

function resolveCanonicalMetricMeta(sourceName, fallbackChannel, lookup = null) {
  const normalized = normalizeMetricSourceName(sourceName);
  if (normalized && lookup?.byInternal?.has(normalized)) {
    return applyMetricSourceRollupOverride(
      lookup.byInternal.get(normalized),
      sourceName,
      fallbackChannel,
    );
  }
  if (normalized && lookup?.byAlias?.has(normalized)) {
    return applyMetricSourceRollupOverride(
      lookup.byAlias.get(normalized),
      sourceName,
      fallbackChannel,
    );
  }
  return applyMetricSourceRollupOverride(
    {
      source: String(sourceName || "Unknown"),
      channel: fallbackChannel || null,
    },
    sourceName,
    fallbackChannel,
  );
}

function buildSpendMergeKey(row = {}, lookup = null) {
  const rawSource = row._id?.source || row.source || "Unknown";
  const rawChannel = row._id?.channel || row.channel || null;
  const meta = resolveCanonicalMetricMeta(rawSource, rawChannel, lookup);
  const source = normalizeMetricSourceName(meta.source || rawSource || "Unknown");
  const family = resolveMetricFamilyKey(meta.channel || rawChannel, meta.source || rawSource);
  return `${source || "unknown"}::${family || "other"}`;
}

function hasSpendSignal(row = {}) {
  return (
    Number(row.spend || 0) > 0 ||
    Number(row.pieces || 0) > 0 ||
    Number(row.impressions || 0) > 0 ||
    Number(row.clicks || 0) > 0 ||
    Number(row.leadsReported || 0) > 0
  );
}

function toSpendAggregateRow(row = {}) {
  return {
    _id: {
      source: row._id?.source || row.source || "Unknown",
      channel: row._id?.channel || row.channel || null,
    },
    spend: Number(row.spend || 0),
    pieces: Number(row.pieces || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    leadsReported: Number(row.leadsReported || 0),
  };
}

function mergeLegacySpendRows(spendRows = [], legacyRows = [], lookup = null) {
  if (!Array.isArray(legacyRows) || legacyRows.length === 0) {
    return Array.isArray(spendRows) ? spendRows : [];
  }

  const merged = Array.isArray(spendRows) ? [...spendRows] : [];
  const seen = new Set(
    merged
      .filter(hasSpendSignal)
      .map((row) => buildSpendMergeKey(row, lookup)),
  );

  for (const legacyRow of legacyRows) {
    if (!hasSpendSignal(legacyRow)) continue;
    const key = buildSpendMergeKey(legacyRow, lookup);
    if (seen.has(key)) continue;
    merged.push(toSpendAggregateRow(legacyRow));
    seen.add(key);
  }

  return merged;
}

function createMetricSourceRow(source, channel = null) {
  return {
    source,
    channel,
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leadsReported: 0,
    count: 0,
    prospects: 0,
    dnc: 0,
    lifetimeDeals: 0,
    lifetimePaid: 0,
    lifetimeInitials: 0,
    payments: 0,
    paymentCount: 0,
    initialPayments: 0,
    initialPaymentCount: 0,
    totalCalls: 0,
    uniqueCallers: 0,
    callsOver5: 0,
  };
}

function preferMetricChannel(currentChannel, nextChannel) {
  const current = String(currentChannel || "").toLowerCase();
  const next = String(nextChannel || "").toLowerCase();
  if (!next) return currentChannel || null;
  if (!current) return nextChannel;

  const weakChannels = new Set(["unknown", "vendor", "mail"]);
  if (weakChannels.has(current) && !weakChannels.has(next)) {
    return nextChannel;
  }

  return currentChannel;
}

function toComparableNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function computeClientInternalScore(caseProfile = null, prospect = null, cadence = null) {
  let score = 0;

  if (caseProfile?.qcSummary?.score != null) {
    score += toComparableNumber(caseProfile.qcSummary.score, 0);
  }

  if (toComparableNumber(caseProfile?.paymentsCount, 0) > 0) {
    score += 20;
  }

  if (toComparableNumber(caseProfile?.totalPaid, 0) > 0) {
    score += Math.min(Math.round(toComparableNumber(caseProfile.totalPaid, 0) / 500), 25);
  }

  if (caseProfile?.conversationAi?.optOutDetected) {
    score -= 40;
  }

  const aiStatus = String(caseProfile?.aiActivityReview?.status || "").toLowerCase();
  if (aiStatus.includes("allow")) {
    score += 10;
  }
  if (aiStatus.includes("do_not_contact") || aiStatus.includes("stop")) {
    score -= 35;
  }

  if (caseProfile?.attribution?.needsReview) {
    score -= 10;
  }

  if (cadence?.active === true) {
    score += 5;
  }

  if (String(prospect?.statusCategory || "").toLowerCase() === "prospect") {
    score += 3;
  }

  return score;
}

function buildClientListRow(domain, caseId, caseProfile = null, prospect = null, cadence = null) {
  const name =
    caseProfile?.name ||
    [caseProfile?.firstName, caseProfile?.lastName].filter(Boolean).join(" ").trim() ||
    prospect?.name ||
    [prospect?.firstName, prospect?.lastName].filter(Boolean).join(" ").trim() ||
    null;

  const status =
    caseProfile?.statusLabel ||
    caseProfile?.status ||
    prospect?.statusLabelRaw ||
    prospect?.statusCategory ||
    null;

  const updatedAt =
    caseProfile?.updatedAt ||
    prospect?.updatedAt ||
    cadence?.updatedAt ||
    null;

  return {
    domain,
    caseId: Number(caseId),
    name,
    email: caseProfile?.email || prospect?.email || cadence?.email || null,
    phone:
      caseProfile?.primaryPhone ||
      prospect?.cellPhone ||
      cadence?.primaryPhone ||
      null,
    status,
    statusId: caseProfile?.statusId ?? prospect?.statusId ?? null,
    statusCategory: caseProfile?.statusCategory || prospect?.statusCategory || null,
    intakeSource:
      cadence?.intakeSource ||
      prospect?.metadata?.intakeSource ||
      null,
    intakeRoute: cadence?.intakeRoute || null,
    activeCadence: cadence?.active === true,
    totalPaid: toComparableNumber(caseProfile?.totalPaid, 0),
    paymentsCount: toComparableNumber(caseProfile?.paymentsCount, 0),
    qcScore: caseProfile?.qcSummary?.score ?? null,
    aiStatus: caseProfile?.aiActivityReview?.status || null,
    optOutDetected: Boolean(caseProfile?.conversationAi?.optOutDetected),
    attributionNeedsReview: Boolean(caseProfile?.attribution?.needsReview),
    sourceCanonicalId:
      caseProfile?.sourceCanonicalId != null ? String(caseProfile.sourceCanonicalId) : null,
    attribution: caseProfile?.attribution || null,
    scrubStatus: caseProfile?.scrubSummary?.status || null,
    lastScrubbedAt: caseProfile?.scrubSummary?.reviewedAt || null,
    internalScore: computeClientInternalScore(caseProfile, prospect, cadence),
    updatedAt,
  };
}

function compareClientRows(sortBy = "updated", sortDir = "desc") {
  const direction = String(sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;

  return (left, right) => {
    if (sortBy === "score") {
      return (left.internalScore - right.internalScore) * direction;
    }
    if (sortBy === "status") {
      const a = String(left.status || "");
      const b = String(right.status || "");
      return a.localeCompare(b) * direction;
    }
    if (sortBy === "payments") {
      return (toComparableNumber(left.totalPaid) - toComparableNumber(right.totalPaid)) * direction;
    }
    if (sortBy === "name") {
      return String(left.name || "").localeCompare(String(right.name || "")) * direction;
    }

    const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    return (leftTime - rightTime) * direction;
  };
}

function computeRingCentralDiagnostics(agents = []) {
  const config = getRingCentralConfig();
  const staleThresholdMs = Math.max(Number(config.presenceStaleThresholdMs) || 120000, 30000);
  const now = Date.now();

  const staleAgents = [];
  const activeCalls = [];
  const recentMissedCalls = [];

  for (const agent of agents) {
    const lastEventReceivedAt = agent.lastEventReceived ? new Date(agent.lastEventReceived).getTime() : 0;
    const isStale = !lastEventReceivedAt || (now - lastEventReceivedAt) > staleThresholdMs;
    if (isStale) {
      staleAgents.push({
        extensionId: agent.extensionId,
        name: agent.name,
        status: agent.status,
        lastEventReceived: agent.lastEventReceived || null,
      });
    }

    if (agent.currentCall?.telephonySessionId || agent.currentCall?.sessionId) {
      activeCalls.push({
        extensionId: agent.extensionId,
        name: agent.name,
        status: agent.status,
        currentCall: agent.currentCall,
      });
    }

    if (agent.lastMissedCallAt) {
      recentMissedCalls.push({
        extensionId: agent.extensionId,
        name: agent.name,
        lastMissedCallAt: agent.lastMissedCallAt,
        lastMissedCallFrom: agent.lastMissedCallFrom || null,
        lastMissedCallTo: agent.lastMissedCallTo || null,
      });
    }
  }

  recentMissedCalls.sort((left, right) => new Date(right.lastMissedCallAt).getTime() - new Date(left.lastMissedCallAt).getTime());

  return {
    staleThresholdMs,
    staleAgentCount: staleAgents.length,
    activeCallCount: activeCalls.length,
    recentMissedCallCount: recentMissedCalls.length,
    staleAgents: staleAgents.slice(0, 10),
    activeCalls: activeCalls.slice(0, 10),
    recentMissedCalls: recentMissedCalls.slice(0, 10),
  };
}

function isEmptyMetricsSlice(slice) {
  return !slice || Object.keys(slice).length === 0;
}

function hasNonZeroCountMap(counts = {}) {
  return Object.values(counts).some((value) => Number(value || 0) > 0);
}

function sumLeadLikeRows(rows = []) {
  return rows.reduce(
    (sum, row) => sum + Number(row.caseCount || row.leadsReported || row.count || 0),
    0,
  );
}

function sumDailySummaryTotals(rows = []) {
  return rows.reduce(
    (summary, row) => {
      summary.leads += Number(row.caseCount || row.leadsReported || row.count || 0);
      summary.calls += Number(row.calls || row.totalCalls || 0);
      summary.spend += Number(row.spend || 0);
      summary.revenue += Number(row.paid || row.payments || 0);
      return summary;
    },
    {
      leads: 0,
      calls: 0,
      spend: 0,
      revenue: 0,
    },
  );
}

async function listMetricSourceCanonicalsAcrossDomains(domains = [], options = {}) {
  const lists = await Promise.all(
    domains.map((domain) => listSourceCanonicals(domain, options).catch(() => [])),
  );
  const byId = new Map();
  for (const doc of lists.flat()) {
    const key = String(doc?._id || "").trim();
    if (!key) continue;
    const current = byId.get(key);
    if (!current || shouldReplaceMetricCanonicalMeta(current, doc)) {
      byId.set(key, doc);
    }
  }
  return [...byId.values()];
}

function buildZeroMetricSlice(date = null) {
  return {
    date: date || null,
    leads: 0,
    calls: 0,
    spend: 0,
    revenue: 0,
    roas: null,
  };
}

function mergeMetricSlicesBySum(slices = [], date = null) {
  const merged = buildZeroMetricSlice(date);
  for (const slice of slices) {
    if (!slice) continue;
    merged.leads += Number(slice.leads || 0);
    merged.calls += Number(slice.calls || 0);
    merged.spend += Number(slice.spend || 0);
    merged.revenue += Number(slice.revenue || 0);
    if (!merged.date && slice.date) {
      merged.date = slice.date;
    }
  }
  merged.roas = merged.spend > 0 ? merged.revenue / merged.spend : null;
  return merged;
}

function mergeCountMapsBySum(countMaps = []) {
  const merged = {
    prospects: 0,
    caseProfiles: 0,
    payments: 0,
    openReviewItems: 0,
  };
  for (const counts of countMaps) {
    if (!counts) continue;
    merged.prospects += Number(counts.prospects || 0);
    merged.caseProfiles += Number(counts.caseProfiles || 0);
    merged.payments += Number(counts.payments || 0);
    merged.openReviewItems += Number(counts.openReviewItems || 0);
  }
  return merged;
}

function pickLatestTimestampRecord(records = []) {
  let latest = null;
  let latestTime = 0;
  for (const record of records) {
    if (!record) continue;
    const time = new Date(
      record.completedAt ||
      record.finishedAt ||
      record.updatedAt ||
      record.createdAt ||
      record.startedAt ||
      0,
    ).getTime();
    if (time >= latestTime) {
      latest = record;
      latestTime = time;
    }
  }
  return latest;
}

function mergeMailCostPieceRows(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const piece = String(row?.piece || row?.source || row?._id?.source || "Unknown");
    const phone = String(row?.phone || row?._id?.phone || "");
    const key = `${piece}::${phone}`;
    if (!merged.has(key)) {
      merged.set(key, {
        piece,
        phone: phone || null,
        spend: 0,
        pieces: 0,
        drops: 0,
        firstDate: row?.firstDate || null,
        lastDate: row?.lastDate || null,
        raw: row?.raw || row,
      });
    }
    const entry = merged.get(key);
    entry.spend += Number(row?.spend ?? row?.totalSpend ?? 0);
    entry.pieces += Number(row?.pieces ?? row?.totalPieces ?? 0);
    entry.drops += Number(row?.drops ?? 0);
    if (row?.firstDate && (!entry.firstDate || String(row.firstDate) < String(entry.firstDate))) {
      entry.firstDate = row.firstDate;
    }
    if (row?.lastDate && (!entry.lastDate || String(row.lastDate) > String(entry.lastDate))) {
      entry.lastDate = row.lastDate;
    }
  }
  return [...merged.values()].sort(
    (left, right) => Number(right.spend || 0) - Number(left.spend || 0),
  );
}

function normalizeMailCostPieceRows(rows = []) {
  return rows.map((row) => ({
    piece:
      row?.piece ||
      row?.name ||
      row?._id?.source ||
      row?.source ||
      "Unknown",
    phone:
      row?.phone ||
      row?._id?.phone ||
      null,
    spend:
      row?.spend ??
      row?.totalSpend ??
      0,
    pieces:
      row?.pieces ??
      row?.totalPieces ??
      0,
    drops:
      row?.drops ??
      0,
    firstDate:
      row?.firstDate ||
      null,
    lastDate:
      row?.lastDate ||
      null,
    raw: row,
  }));
}

function getMetricValue(slice, primaryKey, fallbackCounterKeys = []) {
  if (!slice) return null;
  if (slice[primaryKey] != null) return slice[primaryKey];
  const counters = slice.counters || {};
  for (const key of fallbackCounterKeys) {
    if (counters[key] != null) return counters[key];
  }
  return null;
}

function mergeMetricSlice(currentSlice, legacySlice, fallbackKeys = {}) {
  if (!currentSlice && !legacySlice) return null;
  const merged = {
    ...(legacySlice || {}),
    ...(currentSlice || {}),
  };

  const leads = getMetricValue(currentSlice, "leads", fallbackKeys.leads || ["leads_received"]);
  const calls = getMetricValue(currentSlice, "calls", fallbackKeys.calls || ["calls_received"]);
  const spend = getMetricValue(currentSlice, "spend", fallbackKeys.spend || []);
  const revenue = getMetricValue(currentSlice, "revenue", fallbackKeys.revenue || []);

  merged.leads = leads ?? legacySlice?.leads ?? 0;
  merged.calls = calls ?? legacySlice?.calls ?? 0;
  merged.spend = spend ?? legacySlice?.spend ?? 0;
  merged.revenue = revenue ?? legacySlice?.revenue ?? 0;
  merged.roas =
    currentSlice?.roas ??
    (merged.spend > 0 ? merged.revenue / merged.spend : legacySlice?.roas ?? null);

  return merged;
}

async function resolveLatestMetricsDateForDomain(normalizedDomain, snapshot = null) {
  const candidates = [
    toDateKey(snapshot?.bucketKey),
    toDateKey(getLatestManualDailySummaryDate(normalizedDomain)),
  ].filter(Boolean);

  const excludePieces = await sourceCanonicalRepository
    .listPiecesAssignedToOtherDomains(normalizedDomain)
    .catch(() => []);

  const [latestSpendRows, latestPaymentRows, latestCallRows] = await Promise.all([
    spendEntryRepository.listSpendEntries(normalizedDomain, { limit: 1 }).catch(() => []),
    paymentLedgerRepository.listPaymentsByDateRange(normalizedDomain, { limit: 1 }).catch(() => []),
    dailyCallStatRepository.listDailyCallStats({ limit: 1, excludePieces }).catch(() => []),
  ]);

  candidates.push(
    toDateKey(latestSpendRows?.[0]?.date),
    toDateKey(latestPaymentRows?.[0]?.paymentDateKey),
    toDateKey(latestCallRows?.[0]?.date),
  );

  return candidates
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || todayIsoLA();
}

async function buildWorkspaceShell(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    metrics,
    schedules,
    review,
    ringcentral,
    openConversationCount,
    openDispatchLists,
    recentWorkflowStages,
  ] = await Promise.all([
    buildMetricsWorkspace(normalizedDomain),
    buildScheduleWorkspace(normalizedDomain),
    buildReviewWorkspace(normalizedDomain),
    buildRingCentralWorkspace(normalizedDomain),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "observed" }),
    dispatchListRepository.listDispatchLists(normalizedDomain, { status: "queued", limit: 10 }),
    workflowRecordRepository.listWorkflowRecords({ domain: normalizedDomain, limit: 15 }),
  ]);

  return {
    domain: normalizedDomain,
    cards: {
      metrics: {
        daily: metrics.snapshots.daily,
        lifetime: metrics.snapshots.lifetime,
        counts: metrics.counts,
      },
      schedules: schedules.counts,
      review: review.counts,
      ringcentral: ringcentral.summary,
      inbox: {
        openConversationCount,
      },
      dispatch: {
        queuedCount: openDispatchLists.length,
      },
    },
    recent: {
      reviewItems: review.recentOpenItems,
      cadence: schedules.recentCadence,
      dispatchLists: schedules.recentDispatchLists,
      workflowStages: recentWorkflowStages,
    },
  };
}

async function buildMetricsWorkspaceForDomain(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    daily,
    lifetime,
    latestDeepCutRun,
    prospects,
    caseProfiles,
    payments,
    openReviewItems,
  ] = await Promise.all([
    metricsSnapshotRepository.getLatestDailyMetrics(normalizedDomain),
    metricsSnapshotRepository.findMetricsSnapshot(normalizedDomain, "lifetime", "all-time"),
    deepCutRunRepository.getLatestDeepCutRun(normalizedDomain),
    masterProspectRepository.countMasterProspects(normalizedDomain),
    caseProfileRepository.countCaseProfilesByDomain(normalizedDomain),
    paymentLedgerRepository.countPayments(normalizedDomain),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open" }),
  ]);

  const current = {
    domain: normalizedDomain,
    snapshots: {
      daily,
      lifetime,
    },
    counts: {
      prospects,
      caseProfiles,
      payments,
      openReviewItems,
    },
    latestDeepCutRun,
  };

  const legacy = legacyMetricsFallbackEnabled()
    ? await buildLegacyMetricsWorkspace(normalizedDomain)
    : {
        snapshots: { daily: null, lifetime: null },
        counts: {},
      };
  const metricCounterFallbacks = {
    leads: ["leads", "leads_received"],
    calls: ["calls", "calls_received"],
    spend: ["spend"],
    revenue: ["revenue"],
  };

  const mergedDaily = mergeMetricSlice(daily, legacy.snapshots.daily, metricCounterFallbacks);
  const mergedLifetime = mergeMetricSlice(lifetime, legacy.snapshots.lifetime, metricCounterFallbacks);
  const derivedDailyDate = await resolveLatestMetricsDateForDomain(normalizedDomain, daily).catch(
    () =>
      String(
        toDateKey(daily?.bucketKey) ||
        toDateKey(mergedDaily?.date) ||
        toDateKey(legacy?.snapshots?.daily?.date) ||
        todayIsoLA(),
      ),
  );
  const derivedDailySummary = await buildDailySummaryWorkspace(normalizedDomain, {
    date: derivedDailyDate,
  }).catch(() => null);
  const derivedDailyTotals = sumDailySummaryTotals(derivedDailySummary?.rows || []);
  if (mergedDaily) {
    mergedDaily.date = derivedDailyDate;
    mergedDaily.bucketKey = derivedDailyDate;
    mergedDaily.bucketDate = new Date(`${derivedDailyDate}T00:00:00.000Z`);
    mergedDaily.leads = derivedDailyTotals.leads;
    mergedDaily.calls = derivedDailyTotals.calls;
    mergedDaily.spend = derivedDailyTotals.spend;
    mergedDaily.revenue = derivedDailyTotals.revenue;
    mergedDaily.counters = {
      ...(mergedDaily.counters || {}),
      leads: derivedDailyTotals.leads,
      calls: derivedDailyTotals.calls,
      spend: derivedDailyTotals.spend,
      revenue: derivedDailyTotals.revenue,
    };
    mergedDaily.roas =
      mergedDaily.spend > 0
        ? mergedDaily.revenue / mergedDaily.spend
        : null;
  }

  if (!isEmptyMetricsSlice(daily) || !isEmptyMetricsSlice(lifetime)) {
    return {
      ...current,
      snapshots: {
        daily: mergedDaily,
        lifetime: mergedLifetime,
      },
    };
  }

  return {
    domain: normalizedDomain,
    snapshots: {
      daily: mergedDaily,
      lifetime: mergedLifetime,
    },
    counts: {
      prospects: prospects || legacy.counts.prospects || 0,
      caseProfiles: caseProfiles || legacy.counts.caseProfiles || 0,
      payments: payments || legacy.counts.payments || 0,
      openReviewItems: openReviewItems || legacy.counts.openReviewItems || 0,
    },
    latestDeepCutRun,
  };
}

async function buildMetricsWorkspace(domain) {
  if (!isGlobalMetricsDomain(domain)) {
    return buildMetricsWorkspaceForDomain(domain);
  }

  const metricsDomains = listMetricsDomains();
  const domainWorkspaces = await Promise.all(
    metricsDomains.map((key) => buildMetricsWorkspaceForDomain(key).catch(() => null)),
  );
  const availableWorkspaces = domainWorkspaces.filter(Boolean);
  const latestDailyDate = availableWorkspaces
    .map((workspace) =>
      String(
        workspace?.snapshots?.daily?.date ||
        workspace?.snapshots?.daily?.bucketKey ||
        "",
      ).trim(),
    )
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || todayIsoLA();

  const [dailySummary, lifetimeSources] = await Promise.all([
    buildDailySummaryWorkspace(GLOBAL_METRICS_DOMAIN, {
      date: latestDailyDate,
    }).catch(() => ({ rows: [] })),
    buildMetricSourcesWorkspace(GLOBAL_METRICS_DOMAIN, {
      from: METRICS_ALL_TIME_START,
      to: new Date().toISOString().slice(0, 10),
    }).catch(() => ({ rows: [] })),
  ]);

  const dailyTotals = sumDailySummaryTotals(dailySummary?.rows || []);
  const lifetimeRows = Array.isArray(lifetimeSources?.rows) ? lifetimeSources.rows : [];
  const lifetimeSlice = {
    date: null,
    leads: sumLeadLikeRows(lifetimeRows),
    calls: lifetimeRows.reduce((sum, row) => sum + Number(row.totalCalls || 0), 0),
    spend: lifetimeRows.reduce((sum, row) => sum + Number(row.spend || 0), 0),
    revenue: lifetimeRows.reduce((sum, row) => sum + Number(row.payments || 0), 0),
    roas: null,
  };
  lifetimeSlice.roas =
    lifetimeSlice.spend > 0 ? lifetimeSlice.revenue / lifetimeSlice.spend : null;

  return {
    domain: GLOBAL_METRICS_DOMAIN,
    snapshots: {
      daily: {
        date: latestDailyDate,
        leads: dailyTotals.leads,
        calls: dailyTotals.calls,
        spend: dailyTotals.spend,
        revenue: dailyTotals.revenue,
        roas: dailyTotals.spend > 0 ? dailyTotals.revenue / dailyTotals.spend : null,
      },
      lifetime: lifetimeSlice,
    },
    counts: mergeCountMapsBySum(availableWorkspaces.map((workspace) => workspace.counts)),
    latestDeepCutRun: pickLatestTimestampRecord(
      availableWorkspaces.map((workspace) => workspace.latestDeepCutRun),
    ),
  };
}

async function buildMetricSourcesWorkspace(domain, filters = {}) {
  const normalizedDomain = isGlobalMetricsDomain(domain)
    ? GLOBAL_METRICS_DOMAIN
    : normalizeDomain(domain);
  // Cross-tenant piece exclusion — DailyCallStat is shared across
  // TAG/WYNN/AMITY (single CallRail account), so filter out pieces
  // that explicitly belong to other domains before aggregating.
  const metricsDomains = isGlobalMetricsDomain(domain)
    ? listMetricsDomains()
    : [normalizedDomain];
  let legacy = null;
  let sourceCanonicals = [];
  let spendRows = [];
  let caseRows = [];
  let caseInitialRows = [];
  let roiPaymentEntries = [];
  let callRows = [];
  let manualRows = [];
  let legacySpendRows = [];

  if (isGlobalMetricsDomain(domain)) {
    const [
      canonicalDocs,
      spendLists,
      caseLists,
      caseInitialLists,
      paymentLists,
      sharedCallRows,
      legacySpendLists,
    ] = await Promise.all([
      listMetricSourceCanonicalsAcrossDomains(metricsDomains, { includeInactive: true }).catch(() => []),
      Promise.all(
        metricsDomains.map((key) =>
          spendEntryRepository.summarizeSpendBySource(key, filters).catch(() => []),
        ),
      ),
      Promise.all(
        metricsDomains.map((key) =>
          caseProfileRepository.summarizeCaseProfilesBySource(key).catch(() => []),
        ),
      ),
      Promise.all(
        metricsDomains.map((key) =>
          caseProfileRepository.summarizeInitialPaymentsBySource(key, filters).catch(() => []),
        ),
      ),
      Promise.all(
        metricsDomains.map((key) =>
          listRoiEligiblePayments(key, filters).catch(() => []),
        ),
      ),
      dailyCallStatRepository.summarizeCallStats(filters).catch(() => []),
      Promise.all(
        metricsDomains.map((key) =>
          listLegacySpendRows(key, filters).catch(() => []),
        ),
      ),
    ]);
    sourceCanonicals = canonicalDocs;
    spendRows = spendLists.flat();
    caseRows = caseLists.flat();
    caseInitialRows = caseInitialLists.flat();
    roiPaymentEntries = paymentLists.flat();
    callRows = sharedCallRows;
    legacySpendRows = legacySpendLists.flat();
    manualRows = metricsDomains.flatMap((key) => listManualMetricSourceRows(key, filters));
  } else {
    const excludePieces = await sourceCanonicalRepository
      .listPiecesAssignedToOtherDomains(normalizedDomain)
      .catch(() => []);
    [legacy, sourceCanonicals, spendRows, caseRows, caseInitialRows, roiPaymentEntries, callRows, legacySpendRows] = await Promise.all([
      legacyMetricsFallbackEnabled()
        ? buildLegacyMetricSourcesWorkspace(normalizedDomain, {
            ...filters,
            excludePieces,
          }).catch(() => null)
        : Promise.resolve(null),
      listSourceCanonicals(normalizedDomain, { includeInactive: true }).catch(() => []),
      spendEntryRepository.summarizeSpendBySource(normalizedDomain, filters).catch(() => []),
      caseProfileRepository.summarizeCaseProfilesBySource(normalizedDomain).catch(() => []),
      caseProfileRepository.summarizeInitialPaymentsBySource(normalizedDomain, filters).catch(() => []),
      listRoiEligiblePayments(normalizedDomain, filters).catch(() => []),
      dailyCallStatRepository.summarizeCallStats({ ...filters, excludePieces }).catch(() => []),
      listLegacySpendRows(normalizedDomain, filters).catch(() => []),
    ]);
    manualRows = listManualMetricSourceRows(normalizedDomain, filters);
  }

  const canonicalLookup = buildMetricSourceCanonicalLookup(sourceCanonicals);
  // Alias-aware fallback: fill missing legacy spend without double-counting
  // rows that Parallel already has under a canonical source name.
  spendRows = mergeLegacySpendRows(spendRows, legacySpendRows, canonicalLookup);
  const paymentRows = summarizeRoiPaymentsBySource(roiPaymentEntries);
  const bySource = new Map();

  function ensureMetricEntry(sourceName, fallbackChannel = null) {
    const meta = resolveCanonicalMetricMeta(sourceName, fallbackChannel, canonicalLookup);
    const key = meta.source || "Unknown";
    if (!bySource.has(key)) {
      bySource.set(key, createMetricSourceRow(key, meta.channel || fallbackChannel || null));
    }
    const entry = bySource.get(key);
    entry.channel = preferMetricChannel(
      entry.channel,
      meta.channel || fallbackChannel || null,
    );
    return entry;
  }

  for (const row of spendRows) {
    const entry = ensureMetricEntry(row._id?.source || "Unknown", row._id?.channel || null);
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
  }

  for (const row of caseRows) {
    const source = row._id?.source || row.source || "Unknown";
    const channel = row._id?.channel || row.channel || null;
    const entry = ensureMetricEntry(source, channel);
    entry.count += Number(row.count || 0);
    entry.prospects += Number(row.prospects || 0);
    entry.dnc += Number(row.dnc || 0);
    entry.lifetimeDeals += Number(row.lifetimeDeals || 0);
    entry.lifetimePaid += Number(row.lifetimePaid || 0);
    entry.lifetimeInitials += Number(row.lifetimeInitials || 0);
  }

  for (const row of paymentRows) {
    const source = row._id?.source || row.source || "Unknown";
    const channel = row._id?.channel || row.channel || null;
    const entry = ensureMetricEntry(source, channel);
    entry.payments += Number(row.payments || 0);
    entry.initialPayments += Number(row.initialPayments || 0);
    entry.initialPaymentCount += Number(row.initialPaymentCount || 0);
    entry.paymentCount = Number(entry.initialPaymentCount || 0);
  }

  const caseInitialFallbackRows = new Map();
  for (const row of caseInitialRows) {
    const source = row._id?.source || row.source || "Unknown";
    const channel = row._id?.channel || row.channel || null;
    const meta = resolveCanonicalMetricMeta(source, channel, canonicalLookup);
    const key = meta.source || "Unknown";
    if (!caseInitialFallbackRows.has(key)) {
      caseInitialFallbackRows.set(key, {
        source: key,
        channel: meta.channel || channel || null,
        initialPayments: 0,
        initialPaymentCount: 0,
      });
    }
    const fallbackRow = caseInitialFallbackRows.get(key);
    fallbackRow.channel = preferMetricChannel(
      fallbackRow.channel,
      meta.channel || channel || null,
    );
    fallbackRow.initialPayments += Number(row.initialPayments || 0);
    fallbackRow.initialPaymentCount += Number(row.initialPaymentCount || 0);
  }

  for (const row of caseInitialFallbackRows.values()) {
    const entry = ensureMetricEntry(row.source || "Unknown", row.channel || null);
    entry.initialPayments = Math.max(
      Number(entry.initialPayments || 0),
      Number(row.initialPayments || 0),
    );
    entry.initialPaymentCount = Math.max(
      Number(entry.initialPaymentCount || 0),
      Number(row.initialPaymentCount || 0),
    );
    entry.paymentCount = Math.max(
      Number(entry.paymentCount || 0),
      Number(entry.initialPaymentCount || 0),
    );
  }

  for (const row of callRows) {
    const entry = ensureMetricEntry(row._id?.piece || "Unknown", row._id?.channel || null);
    entry.totalCalls += Number(row.totalCalls || 0);
    entry.uniqueCallers += Number(row.uniqueCallers || 0);
    entry.callsOver5 += Number(row.callsOver5 || 0);
    if (resolveMetricFamilyKey(entry.channel, entry.source) === "mail") {
      entry.leadsReported = Math.max(Number(entry.leadsReported || 0), Number(entry.uniqueCallers || 0));
    }
  }

  for (const row of manualRows) {
    const entry = ensureMetricEntry(row.source || "Unknown", row.channel || null);
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
    entry.count += Number(row.count || 0);
  }

  const rows = [...bySource.values()]
    .map((row) => ({
      ...row,
      paymentCount: Number(row.initialPaymentCount || 0),
      roas: row.spend > 0 ? row.payments / row.spend : null,
      channelFamilyKey: resolveMetricFamilyKey(row.channel, row.source),
    }))
    .sort((left, right) => {
      const leftWeight =
        Number(left.spend || 0) +
        Number(left.payments || 0) +
        Number(left.initialPayments || 0) +
        Number(left.totalCalls || 0) +
        Number(left.count || 0);
      const rightWeight =
        Number(right.spend || 0) +
        Number(right.payments || 0) +
        Number(right.initialPayments || 0) +
        Number(right.totalCalls || 0) +
        Number(right.count || 0);
      return rightWeight - leftWeight;
    });

  const hasLiveSignal = rows.some((row) =>
    Number(row.spend || 0) > 0 ||
    Number(row.payments || 0) > 0 ||
    Number(row.initialPayments || 0) > 0 ||
    Number(row.totalCalls || 0) > 0 ||
    Number(row.callsOver5 || 0) > 0 ||
    Number(row.count || 0) > 0
  );

  if (!hasLiveSignal && Array.isArray(legacy?.rows) && legacy.rows.length > 0) {
    return {
      ...legacy,
      rows: legacy.rows.map((row) => ({
        ...row,
        channelFamilyKey: resolveMetricFamilyKey(row.channel, row.source),
      })),
    };
  }

  return {
    domain: normalizedDomain,
    rows,
  };
}

async function buildDailySummaryWorkspace(domain, filters = {}) {
  const normalizedDomain = isGlobalMetricsDomain(domain)
    ? GLOBAL_METRICS_DOMAIN
    : normalizeDomain(domain);
  const date = String(filters.date || todayIsoLA());
  const metricsDomains = isGlobalMetricsDomain(domain)
    ? listMetricsDomains()
    : [normalizedDomain];
  let sourceCanonicals = [];
  let spendRows = [];
  let roiPaymentEntries = [];
  let callRows = [];
  let manualRows = [];
  let excludePieces = [];
  // Legacy spend rows (always fetched alongside Parallel) so today's
  // mail drops show up on the daily-pulse panel even when the Parallel
  // SpendEntry sync hasn't landed yet for `date`. Merge logic below
  // prefers Parallel's row when present and falls back to legacy.
  let legacySpendRows = [];

  if (isGlobalMetricsDomain(domain)) {
    const [canonicalDocs, spendLists, paymentLists, sharedCallRows, legacySpendLists] = await Promise.all([
      listMetricSourceCanonicalsAcrossDomains(metricsDomains, { includeInactive: true }).catch(() => []),
      Promise.all(
        metricsDomains.map((key) =>
          spendEntryRepository.summarizeSpendBySource(key, { date }).catch(() => []),
        ),
      ),
      Promise.all(
        metricsDomains.map((key) =>
          listRoiEligiblePayments(key, { date }).catch(() => []),
        ),
      ),
      dailyCallStatRepository.summarizeCallStats({ date }).catch(() => []),
      Promise.all(
        metricsDomains.map((key) =>
          listLegacySpendRows(key, { date }).catch(() => []),
        ),
      ),
    ]);
    sourceCanonicals = canonicalDocs;
    spendRows = spendLists.flat();
    roiPaymentEntries = paymentLists.flat();
    callRows = sharedCallRows;
    manualRows = metricsDomains.flatMap((key) => listManualDailySummaryRows(key, date));
    legacySpendRows = legacySpendLists.flat();
  } else {
    excludePieces = await sourceCanonicalRepository
      .listPiecesAssignedToOtherDomains(normalizedDomain)
      .catch(() => []);
    [sourceCanonicals, spendRows, roiPaymentEntries, callRows, legacySpendRows] = await Promise.all([
      listSourceCanonicals(normalizedDomain, { includeInactive: true }).catch(() => []),
      spendEntryRepository.summarizeSpendBySource(normalizedDomain, { date }),
      listRoiEligiblePayments(normalizedDomain, { date }),
      dailyCallStatRepository.summarizeCallStats({ date, excludePieces }),
      listLegacySpendRows(normalizedDomain, { date }).catch(() => []),
    ]);
    manualRows = listManualDailySummaryRows(normalizedDomain, date);
  }

  // Bridge legacy spend during migration, without duplicating canonical
  // source/family buckets already present in Parallel.
  const canonicalLookup = buildMetricSourceCanonicalLookup(sourceCanonicals);
  spendRows = mergeLegacySpendRows(spendRows, legacySpendRows, canonicalLookup);
  const rows = new Map();

  function ensureDailySummaryEntry(sourceName, fallbackChannel = null) {
    const meta = resolveCanonicalMetricMeta(sourceName, fallbackChannel, canonicalLookup);
    const key = meta.source || "Unknown";
    if (!rows.has(key)) {
      rows.set(key, {
        source: key,
        channel: meta.channel || fallbackChannel || null,
        spend: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
        leadsReported: 0,
        deals: 0,
        initials: 0,
        paid: 0,
        calls: 0,
        callsOver5: 0,
        caseCount: 0,
      });
    }
    const entry = rows.get(key);
    entry.channel = preferMetricChannel(
      entry.channel,
      meta.channel || fallbackChannel || null,
    );
    return entry;
  }

  for (const row of spendRows) {
    const entry = ensureDailySummaryEntry(row._id?.source || "Unknown", row._id?.channel || null);
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
  }

  for (const entry of roiPaymentEntries) {
    if (!entry?.roiEligible) continue;
    const payment = entry.payment || {};
    const paymentMeta = resolveRoiPaymentSourceMeta(payment, entry.caseProfile);
    const rowEntry = ensureDailySummaryEntry(paymentMeta.source || "Unknown", paymentMeta.channel || null);
    rowEntry.paid += Number(payment.amount || 0);
    rowEntry.deals += String(payment.paymentType || "").toLowerCase() === "initial" ? 1 : 0;
    rowEntry.initials += String(payment.paymentType || "").toLowerCase() === "initial"
      ? Number(payment.amount || 0)
      : 0;
    rowEntry.channel = preferMetricChannel(rowEntry.channel, paymentMeta.channel);
  }

  for (const row of callRows) {
    const entry = ensureDailySummaryEntry(row._id?.piece || "Unknown", row._id?.channel || null);
    entry.calls += row.totalCalls || 0;
    entry.callsOver5 += row.callsOver5 || 0;
    entry.channel = preferMetricChannel(entry.channel, row._id?.channel || null);
    if (resolveMetricFamilyKey(entry.channel, entry.source) === "mail") {
      entry.leadsReported = Math.max(Number(entry.leadsReported || 0), Number(row.uniqueCallers || 0));
      entry.caseCount = Math.max(Number(entry.caseCount || 0), Number(row.uniqueCallers || 0));
    }
  }

  for (const row of manualRows) {
    const entry = ensureDailySummaryEntry(row.source || "Unknown", row.channel || null);
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
    entry.caseCount += Number(row.count || row.leadsReported || 0);
    entry.channel = preferMetricChannel(entry.channel, row.channel || null);
  }

  const mergedRows = [...rows.values()]
    .map((row) => ({
      ...row,
      channelFamilyKey: resolveMetricFamilyKey(row.channel, row.source),
    }))
    .sort((left, right) => {
      const leftWeight = (left.spend || 0) + (left.paid || 0) + (left.calls || 0);
      const rightWeight = (right.spend || 0) + (right.paid || 0) + (right.calls || 0);
      return rightWeight - leftWeight;
    });

  if (mergedRows.length > 0) {
    return {
      domain: normalizedDomain,
      date,
      rows: mergedRows,
    };
  }

  const legacy = !legacyMetricsFallbackEnabled() || isGlobalMetricsDomain(domain)
    ? null
    : await buildLegacyDailySummaryWorkspace(normalizedDomain, {
        date,
        excludePieces,
      }).catch(() => null);
  if (Array.isArray(legacy?.rows) && legacy.rows.length > 0) {
    return {
      ...legacy,
      rows: legacy.rows.map((row) => ({
        ...row,
        channelFamilyKey: resolveMetricFamilyKey(row.channel, row.source),
      })),
    };
  }

  return {
    domain: normalizedDomain,
    date,
    rows: mergedRows,
  };
}

async function buildMailCostWorkspace(domain, filters = {}) {
  const normalizedDomain = isGlobalMetricsDomain(domain)
    ? GLOBAL_METRICS_DOMAIN
    : normalizeDomain(domain);

  if (isGlobalMetricsDomain(domain)) {
    const metricsDomains = listMetricsDomains();
    const workspaces = await Promise.all(
      metricsDomains.map((key) =>
        buildMailCostWorkspace(key, filters).catch(() => null),
      ),
    );

    const totals = workspaces.reduce(
      (summary, row) => {
        const workspaceTotals = row?.totals || {};
        summary.spend += Number(workspaceTotals.spend || 0);
        summary.pieces += Number(workspaceTotals.pieces || 0);
        summary.impressions += Number(workspaceTotals.impressions || 0);
        summary.clicks += Number(workspaceTotals.clicks || 0);
        summary.leadsReported += Number(workspaceTotals.leadsReported || 0);
        summary.rows += Number(workspaceTotals.rows || row?.rows?.length || 0);
        return summary;
      },
      { spend: 0, pieces: 0, impressions: 0, clicks: 0, leadsReported: 0, rows: 0 },
    );
    const byPiece = mergeMailCostPieceRows(
      normalizeMailCostPieceRows(workspaces.flatMap((row) => row?.byPiece || [])),
    );
    const rows = workspaces
      .flatMap((row) => row?.rows || [])
      .sort((left, right) =>
        String(right?.date || right?.updatedAt || "").localeCompare(
          String(left?.date || left?.updatedAt || ""),
        ),
      );

    return {
      domain: GLOBAL_METRICS_DOMAIN,
      totals,
      byPiece,
      rows,
    };
  }

  const legacy = legacyMetricsFallbackEnabled()
    ? await buildLegacyMailCostWorkspace(normalizedDomain, filters)
    : null;
  if (
    Number(legacy?.totals?.spend || 0) > 0 ||
    Number(legacy?.totals?.pieces || 0) > 0 ||
    (Array.isArray(legacy?.byPiece) && legacy.byPiece.length > 0) ||
    (Array.isArray(legacy?.rows) && legacy.rows.length > 0)
  ) {
    return {
      ...legacy,
      byPiece: normalizeMailCostPieceRows(legacy.byPiece || []),
    };
  }
  const [totals, byPiece, rows] = await Promise.all([
    spendEntryRepository.getSpendTotals(normalizedDomain, { ...filters, channel: "mailer" }),
    spendEntryRepository.summarizeMailCosts(normalizedDomain, filters),
    spendEntryRepository.listSpendEntries(normalizedDomain, { ...filters, channel: "mailer", limit: filters.limit || 200 }),
  ]);

  return {
    domain: normalizedDomain,
    totals,
    byPiece: normalizeMailCostPieceRows(byPiece),
    rows,
  };
}

async function buildCallrailWorkspace(filters = {}) {
  // Cross-tenant piece exclusion — DailyCallStat is shared across
  // TAG/WYNN/AMITY. When a domain is passed in, drop rows explicitly
  // owned by other tenants before aggregating.
  const normalizedDomain = filters.domain && !isGlobalMetricsDomain(filters.domain)
    ? normalizeDomain(filters.domain)
    : null;
  const excludePieces = normalizedDomain
    ? await sourceCanonicalRepository
        .listPiecesAssignedToOtherDomains(normalizedDomain)
        .catch(() => [])
    : [];
  const repoFilters = { ...filters, excludePieces };

  const [summary, rows] = await Promise.all([
    dailyCallStatRepository.summarizeCallsByChannel(repoFilters),
    dailyCallStatRepository.summarizeCallStats(repoFilters),
  ]);

  if ((Array.isArray(summary) && summary.length > 0) || (Array.isArray(rows) && rows.length > 0)) {
    return {
      date: filters.date || null,
      from: filters.from || null,
      to: filters.to || null,
      summary,
      rows,
    };
  }

  return legacyMetricsFallbackEnabled()
    ? buildLegacyCallrailWorkspace(filters)
    : {
        date: filters.date || null,
        from: filters.from || null,
        to: filters.to || null,
        summary,
        rows,
      };
}

async function buildRedlineWorkspace(domain, filters = {}) {
  const normalizedDomain = isGlobalMetricsDomain(domain)
    ? GLOBAL_METRICS_DOMAIN
    : normalizeDomain(domain);
  const metricsDomains = isGlobalMetricsDomain(domain)
    ? listMetricsDomains()
    : [normalizedDomain];
  const domainResults = await Promise.all(
    metricsDomains.map(async (key) => {
      const [
        pendingCount,
        suppressedCount,
        sentCount,
        pendingAlerts,
        reviewRedlines,
      ] = await Promise.all([
        paymentAlertRepository.countPaymentAlerts(key, { status: "pending" }),
        paymentAlertRepository.countPaymentAlerts(key, { status: "suppressed" }),
        paymentAlertRepository.countPaymentAlerts(key, { status: "sent" }),
        paymentAlertRepository.listPaymentAlerts(key, {
          status: filters.status || "pending",
          limit: filters.limit,
        }),
        reviewQueueRepository.listReviewQueueItems(key, {
          category: "redline",
          limit: 50,
        }),
      ]);

      return {
        counts: {
          pending: pendingCount,
          suppressed: suppressedCount,
          sent: sentCount,
          reviewRedlines: reviewRedlines.length,
        },
        alerts: pendingAlerts,
        reviewItems: reviewRedlines,
      };
    }),
  );
  const counts = domainResults.reduce(
    (summary, result) => {
      summary.pending += Number(result?.counts?.pending || 0);
      summary.suppressed += Number(result?.counts?.suppressed || 0);
      summary.sent += Number(result?.counts?.sent || 0);
      summary.reviewRedlines += Number(result?.counts?.reviewRedlines || 0);
      return summary;
    },
    { pending: 0, suppressed: 0, sent: 0, reviewRedlines: 0 },
  );
  const pendingAlerts = domainResults.flatMap((result) => result?.alerts || []);
  const reviewRedlines = domainResults.flatMap((result) => result?.reviewItems || []);

  if (hasNonZeroCountMap(counts) || pendingAlerts.length > 0 || reviewRedlines.length > 0) {
    return {
      domain: normalizedDomain,
      counts,
      alerts: pendingAlerts,
      reviewItems: reviewRedlines,
    };
  }

  return isGlobalMetricsDomain(domain)
    ? {
        domain: GLOBAL_METRICS_DOMAIN,
        counts,
        alerts: pendingAlerts,
        reviewItems: reviewRedlines,
      }
    : legacyMetricsFallbackEnabled()
      ? buildLegacyRedlineWorkspace(normalizedDomain, filters)
      : {
          domain: normalizedDomain,
          counts,
          alerts: pendingAlerts,
          reviewItems: reviewRedlines,
        };
}

async function buildScheduleWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    activeCadenceCount,
    inactiveCadenceCount,
    dueSmsCount,
    dueEmailCount,
    dueRvmCount,
    dueCxCount,
    recentCadence,
    recentDispatchLists,
  ] = await Promise.all([
    leadCadenceRepository.countLeadCadence(normalizedDomain, { active: true }),
    leadCadenceRepository.countLeadCadence(normalizedDomain, { active: false }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "sms" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "email" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "rvm" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "cx" }),
    leadCadenceRepository.listLeadCadence(normalizedDomain, { limit: 10 }),
    dispatchListRepository.listDispatchLists(normalizedDomain, { limit: 10 }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      activeCadence: activeCadenceCount,
      inactiveCadence: inactiveCadenceCount,
      dueByChannel: {
        sms: dueSmsCount,
        email: dueEmailCount,
        rvm: dueRvmCount,
        cx: dueCxCount,
      },
    },
    recentCadence,
    recentDispatchLists,
  };
}

async function listScheduleCadence(domain, filters = {}) {
  return leadCadenceRepository.listLeadCadence(normalizeDomain(domain), filters);
}

async function buildScheduleHistoryWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  return workflowRecordRepository.listWorkflowRecords({
    domain: normalizedDomain,
    family: filters.family || "dispatch",
    subtype: filters.subtype,
    stage: filters.stage,
    caseId: filters.caseId,
    aggregateType: filters.aggregateType,
    aggregateId: filters.aggregateId,
    limit: filters.limit || 50,
  });
}

async function buildReviewWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    openCount,
    reviewedCount,
    warningCount,
    criticalCount,
    recentOpenItems,
    recentDailyRuns,
  ] = await Promise.all([
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "reviewed" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "warning" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "critical" }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { status: "open", limit: 15 }),
    deepCutRunRepository.listDeepCutRuns(normalizedDomain, { limit: 10 }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      open: openCount,
      reviewed: reviewedCount,
      warning: warningCount,
      critical: criticalCount,
    },
    recentOpenItems,
    recentDailyRuns,
  };
}

async function listReviewWorkspaceItems(domain, filters = {}) {
  return reviewQueueRepository.listReviewQueueItems(normalizeDomain(domain), filters);
}

async function buildInboxWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    openCount,
    draftedCount,
    reviewCount,
    optOutCount,
    workflows,
    recentReviewItems,
    recentWorkflowStages,
  ] = await Promise.all([
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "observed" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "drafted" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "manual-review" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { optOutDetected: true }),
    conversationWorkflowRepository.listConversationWorkflows(normalizedDomain, {
      status: filters.status,
      channel: filters.channel,
      search: filters.search,
      limit: filters.limit,
      includeAutoResponded: Boolean(filters.includeAutoResponded),
    }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      workflow: filters.workflow || "conversation-ai",
      limit: 20,
    }),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      family: filters.family || "conversation",
      limit: 20,
    }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      observed: openCount,
      drafted: draftedCount,
      manualReview: reviewCount,
      optOutDetected: optOutCount,
    },
    workflows,
    recentReviewItems,
    recentWorkflowStages,
  };
}

async function buildClientDetail(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const viewer = options.viewer || null;

  const [
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    recentWorkflowStages,
  ] = await Promise.all([
    masterProspectRepository.findMasterProspect(normalizedDomain, numericCaseId),
    caseProfileRepository.findCaseProfile(normalizedDomain, numericCaseId),
    leadCadenceRepository.findLeadCadence(normalizedDomain, numericCaseId),
    paymentLedgerRepository.listPaymentsForCase(normalizedDomain, numericCaseId),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { caseId: numericCaseId, limit: 50 }),
    activityAiReviewRepository.findLatestActivityAiReview(normalizedDomain, numericCaseId),
    qualityReviewRepository.findLatestQualityReview(normalizedDomain, numericCaseId),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      caseId: numericCaseId,
      limit: 20,
    }),
  ]);

  const primaryPhone = caseProfile?.primaryPhone || prospect?.cellPhone || prospect?.homePhone || prospect?.workPhone || null;
  const [latestConversationWorkflow, calls, textChain] = await Promise.all([
    primaryPhone
      ? conversationWorkflowRepository.findConversationWorkflow(normalizedDomain, primaryPhone)
      : Promise.resolve(null),
    // Case-scoped call history — CallLog rows linked via caseId, with
    // transcription.recordingUri for inline audio playback in the UI.
    callLogRepository.listCallLogsByCaseId(normalizedDomain, numericCaseId, {
      limit: 25,
    }),
    // Text chain for the case's primary phone. ConversationMessage
    // rows are keyed on phone, not caseId, so we look up by phone.
    // Returns newest-first; UI can reverse for chronological display.
    primaryPhone
      ? conversationMessageRepository.listRecentMessagesForPhone(
          normalizedDomain,
          primaryPhone,
          { limit: 50 },
        )
      : Promise.resolve([]),
  ]);

  // Rewrite each call's `transcription.recordingUri` to a Parallel-
  // signed proxy URL when it points at RC media. The audio element
  // can't add Authorization headers — so we mint a sig'd URL the
  // browser can fetch as-is. Drive URLs pass through unchanged
  // (Apps Script owns Drive URL minting). When `viewer` isn't
  // available (no auth context), the helper passes raw — broken
  // playback is still visibly broken in dev / curl flows rather
  // than silently rewritten with no viewer to verify against.
  const callsWithSignedUrls = (calls || []).map((call) => {
    const recordingUri = call?.transcription?.recordingUri;
    if (!recordingUri || !viewer) return call;
    return {
      ...call,
      transcription: {
        ...(call.transcription || {}),
        recordingUri: mintRecordingPlaybackUrl(recordingUri, { viewer }),
      },
    };
  });

  return {
    domain: normalizedDomain,
    caseId: numericCaseId,
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    latestConversationWorkflow,
    recentWorkflowStages,
    calls: callsWithSignedUrls,
    textChain,
    scrubSummary: caseProfile?.scrubSummary || null,
    availableSources: await listActiveSourceCanonicals(normalizedDomain),
  };
}

async function buildClientWorkspaceList(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const statusCategoryFilter = String(filters.statusCategory || "").trim().toLowerCase();
  const includeProspects = !statusCategoryFilter || statusCategoryFilter === "prospect";
  const includeCaseProfiles = !statusCategoryFilter || statusCategoryFilter !== "prospect";

  const [prospects, caseProfiles] = await Promise.all([
    includeProspects
      ? masterProspectRepository.listMasterProspects(normalizedDomain, {
          search: filters.search,
          statusCategory: statusCategoryFilter === "prospect" ? "prospect" : undefined,
          limit,
        })
      : Promise.resolve([]),
    includeCaseProfiles
      ? caseProfileRepository.listCaseProfiles(normalizedDomain, {
          search: filters.search,
          statusCategory: statusCategoryFilter || undefined,
          hasPayments:
            filters.hasPayments === "true"
              ? true
              : filters.hasPayments === "false"
                ? false
                : undefined,
          aiStatus: filters.aiStatus,
          limit,
        })
      : Promise.resolve([]),
  ]);

  const caseIds = [
    ...new Set(
      [...prospects, ...caseProfiles]
        .map((entry) => Number(entry.caseId))
        .filter(Number.isFinite),
    ),
  ];

  const cadenceRows = await leadCadenceRepository.listLeadCadenceByCaseIds(normalizedDomain, caseIds);
  const cadenceByCaseId = new Map(cadenceRows.map((row) => [Number(row.caseId), row]));

  const merged = new Map();

  for (const prospect of prospects) {
    const id = Number(prospect.caseId);
    merged.set(id, {
      prospect,
      caseProfile: null,
      cadence: cadenceByCaseId.get(id) || null,
    });
  }

  for (const caseProfile of caseProfiles) {
    const id = Number(caseProfile.caseId);
    const current = merged.get(id) || {
      prospect: null,
      caseProfile: null,
      cadence: cadenceByCaseId.get(id) || null,
    };
    current.caseProfile = caseProfile;
    merged.set(id, current);
  }

  let rows = [...merged.entries()].map(([caseIdValue, entry]) =>
    buildClientListRow(
      normalizedDomain,
      caseIdValue,
      entry.caseProfile,
      entry.prospect,
      entry.cadence,
    ),
  );

  if (filters.status) {
    const statusNeedle = String(filters.status).trim().toLowerCase();
    rows = rows.filter((row) => String(row.status || "").toLowerCase().includes(statusNeedle));
  }

  if (filters.activeCadence === "true") {
    rows = rows.filter((row) => row.activeCadence);
  } else if (filters.activeCadence === "false") {
    rows = rows.filter((row) => !row.activeCadence);
  }

  rows.sort(compareClientRows(filters.sortBy, filters.sortDir));

  return {
    domain: normalizedDomain,
    total: rows.length,
    items: rows.slice(0, limit),
    filters: {
      search: filters.search || "",
      status: filters.status || null,
      statusCategory: filters.statusCategory || null,
      sortBy: filters.sortBy || "updated",
      sortDir: filters.sortDir || "desc",
      activeCadence: filters.activeCadence || null,
    },
  };
}

async function searchClientWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const search = String(filters.search || "").trim();
  const limit = Math.min(Number(filters.limit) || 25, 100);
  const scope = String(filters.scope || "all").trim().toLowerCase();

  const [prospects, caseProfiles] = await Promise.all([
    scope === "clients"
      ? Promise.resolve([])
      : masterProspectRepository.listMasterProspects(normalizedDomain, { search, limit }),
    scope === "prospects"
      ? Promise.resolve([])
      : caseProfileRepository.listCaseProfiles(normalizedDomain, { search, limit }),
  ]);

  const prospectsByCaseId = new Map(
    prospects
      .map((prospect) => [Number(prospect.caseId), prospect])
      .filter(([caseId]) => Number.isFinite(caseId)),
  );
  const byCaseId = new Map();
  for (const prospect of prospects) {
    const caseId = Number(prospect.caseId);
    if (!Number.isFinite(caseId)) continue;
    byCaseId.set(caseId, buildClientListRow(normalizedDomain, caseId, null, prospect, null));
  }
  for (const caseProfile of caseProfiles) {
    const caseId = Number(caseProfile.caseId);
    if (!Number.isFinite(caseId)) continue;
    const current = byCaseId.get(caseId);
    byCaseId.set(
      caseId,
      buildClientListRow(
        normalizedDomain,
        caseId,
        caseProfile,
        prospectsByCaseId.get(caseId) || null,
        null,
      ),
    );
  }

  return {
    domain: normalizedDomain,
    search,
    scope,
    prospects,
    caseProfiles,
    merged: [...byCaseId.values()].sort(compareClientRows("updated", "desc")).slice(0, limit),
  };
}

async function buildRingCentralWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const rawAgents = await agentStateRepository.listAgentStates({ company: normalizedDomain });
  const agents = rawAgents.map((agent) => ({
    ...agent,
    presence: agent.exPresenceStatus || agent.status || null,
    telephonyStatus: agent.exTelephonyStatus || "NoCall",
    lastUpdate:
      agent.lastStatusChange
      || agent.lastPresencePollAt
      || agent.lastEventReceived
      || agent.updatedAt
      || null,
    callsToday: Number(agent.dailyStats?.totalCalls || 0),
    freshLeadGate: deriveFreshLeadGate(agent, agent.cxRouting || null),
  }));
  const diagnostics = computeRingCentralDiagnostics(agents);

  const summary = agents.reduce((accumulator, agent) => {
    accumulator.total += 1;
    accumulator.byStatus[agent.status] = (accumulator.byStatus[agent.status] || 0) + 1;
    if (agent.cxRouting?.desiredAvailability === "unavailable") {
      accumulator.cxUnavailable += 1;
    }
    if (agent.freshLeadGate?.blocked && agent.freshLeadGate?.source !== "routing-disabled") {
      accumulator.freshLeadBlocked += 1;
    }
    if (agent.freshLeadGate?.source === "ex-call") {
      accumulator.freshLeadBlockedByEx += 1;
    }
    if (agent.currentCall?.telephonySessionId || agent.currentCall?.sessionId) {
      accumulator.activeCalls += 1;
    }
    return accumulator;
  }, {
    total: 0,
    cxUnavailable: 0,
    freshLeadBlocked: 0,
    freshLeadBlockedByEx: 0,
    activeCalls: 0,
    byStatus: {},
  });

  return {
    domain: normalizedDomain,
    summary,
    diagnostics,
    agents,
  };
}

async function buildRingBridgeWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [presence, providerHealth, recentWorkflowStages, recentReviewItems] = await Promise.all([
    buildRingCentralWorkspace(normalizedDomain),
    buildProviderHealth(normalizedDomain),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      family: "ringcentral",
      limit: 20,
    }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      limit: 10,
    }),
  ]);

  return {
    domain: normalizedDomain,
    presence,
    runtime: providerHealth.runtimeStatus?.ringcentral || null,
    providerHealth,
    diagnostics: presence.diagnostics,
    recentWorkflowStages,
    recentReviewItems,
  };
}

async function listRingCentralEvents(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  return workflowRecordRepository.listWorkflowRecords({
    domain: normalizedDomain,
    family: "ringcentral",
    subtype: filters.subtype,
    stage: filters.stage,
    aggregateType: filters.aggregateType,
    aggregateId: filters.aggregateId,
    caseId: filters.caseId,
    limit: filters.limit || 50,
  });
}

async function buildDeployWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [controlPlane, providerHealth, recentServiceAlerts] = await Promise.all([
    buildControlPlaneHealthReport(),
    buildProviderHealth(normalizedDomain),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      workflow: "service-health",
      limit: 20,
    }),
  ]);

  return {
    domain: normalizedDomain,
    topology: listServiceTopology({ ports: PORTS }),
    controlPlane,
    providerHealth,
    recentServiceAlerts,
  };
}

async function buildLibraryWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const catalog = buildContactLibraryCatalog();
  const [recentEmailDispatches, recentSmsDispatches] = await Promise.all([
    dispatchListRepository.listDispatchLists(normalizedDomain, {
      channel: "email",
      limit: 15,
    }),
    dispatchListRepository.listDispatchLists(normalizedDomain, {
      channel: "sms",
      limit: 15,
    }),
  ]);

  return {
    domain: normalizedDomain,
    catalogs: {
      textMessages: catalog.sms.entries,
      emailTemplates: catalog.email.entries,
      campaigns: [],
    },
    summary: {
      smsCount: catalog.sms.count,
      emailCount: catalog.email.count,
      smsCategories: catalog.sms.byCategory,
      emailCategories: catalog.email.byCategory,
      emailBrands: catalog.email.byBrand,
    },
    recentUsage: {
      emailDispatches: recentEmailDispatches,
      smsDispatches: recentSmsDispatches,
    },
    capabilities: {
      canEditTextLibrary: true,
      canEditEmailTemplates: true,
      canLaunchEmailCampaigns: true,
      canLaunchTextCampaigns: true,
    },
    notes: [
      "Library content is currently sourced from the original TagContactBridge templates and text library.",
      "Next step is materializing edited campaign content into parallel-owned storage instead of filesystem-backed reads.",
    ],
    source: catalog.source,
  };
}

module.exports = {
  buildClientDetail,
  buildClientWorkspaceList,
  buildCallrailWorkspace,
  buildDailySummaryWorkspace,
  buildDeployWorkspace,
  buildInboxWorkspace,
  buildLibraryWorkspace,
  buildMailCostWorkspace,
  buildMetricsWorkspace,
  buildMetricSourcesWorkspace,
  buildRedlineWorkspace,
  buildReviewWorkspace,
  buildRingBridgeWorkspace,
  buildRingCentralWorkspace,
  buildScheduleWorkspace,
  buildWorkspaceShell,
  buildScheduleHistoryWorkspace,
  listRingCentralEvents,
  listReviewWorkspaceItems,
  listScheduleCadence,
  searchClientWorkspace,
};
