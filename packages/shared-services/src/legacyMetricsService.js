"use strict";

const mongoose = require("mongoose");
const {
  listManualDailySummaryRows,
  listManualMetricSourceRows,
} = require("./metricsManualOverlayService");

function getLegacyDbName() {
  return String(process.env.LEGACY_APP_DB_NAME || "test").trim() || "test";
}

function getLegacyDb() {
  return mongoose.connection.useDb(getLegacyDbName(), { useCache: true });
}

function getMirrorDb() {
  return mongoose.connection.db;
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildDateRangeMatch(filters = {}) {
  if (filters.date) {
    return { date: String(filters.date) };
  }

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return Object.keys(range).length > 0 ? { date: range } : {};
}

function applyPieceFilters(match = {}, filters = {}) {
  if (Array.isArray(filters.excludePieces) && filters.excludePieces.length > 0) {
    match.piece = Object.assign(match.piece || {}, {
      $nin: filters.excludePieces,
    });
  }
  return match;
}

function buildMirrorCollectionName(collectionName) {
  return `legacy_${collectionName}`;
}

function resolveMonthKey(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 7);
  }

  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}/.test(text)) {
    return text.slice(0, 7);
  }

  const parsed = text ? new Date(text) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 7);
  }

  return "";
}

function createLegacySourceRow(source, channel = null) {
  return {
    source,
    channel,
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leadsReported: 0,
    count: 0,
    payments: 0,
    paymentCount: 0,
    initialPayments: 0,
    initialPaymentCount: 0,
    totalCalls: 0,
    uniqueCallers: 0,
    callsOver5: 0,
  };
}

function createLegacyDailyRow(source, channel = null) {
  return {
    source,
    channel,
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leadsReported: 0,
    deals: 0,
    paid: 0,
    calls: 0,
    callsOver5: 0,
    caseCount: 0,
    initials: 0,
    redlines: 0,
    postdates: 0,
  };
}

function sumLegacyLeadLikeRows(rows = []) {
  return rows.reduce(
    (sum, row) => sum + Number(row.caseCount || row.leadsReported || row.count || 0),
    0,
  );
}

function isLegacyRoiPaymentRow(payment = {}, caseProfile = null) {
  const type = String(payment.type || "").toLowerCase();
  if (type === "initial") return true;
  if (type !== "recurring") return false;
  const paymentMonth = resolveMonthKey(payment.date);
  const firstPaymentMonth = resolveMonthKey(caseProfile?.firstPaymentDate);
  return Boolean(paymentMonth && firstPaymentMonth && paymentMonth === firstPaymentMonth);
}

async function listLegacyCaseProfilesByCaseIds(domain, caseIds = []) {
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];

  const normalizedDomain = normalizeDomain(domain);
  const match = {
    domain: normalizedDomain,
    caseId: { $in: normalizedIds },
  };
  const collection = await resolveMetricsCollection("rb_caseprofiles", match);
  return collection.collection.find(
    match,
    {
      projection: {
        caseId: 1,
        firstPaymentDate: 1,
        sourceName: 1,
        sourceChannel: 1,
      },
    },
  ).toArray();
}

async function listLegacyRoiPaymentRows(domain, paymentCollection, match = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const paymentRows = await paymentCollection.collection.find({
    domain: normalizedDomain,
    ...match,
  }).toArray();

  const caseProfiles = await listLegacyCaseProfilesByCaseIds(
    normalizedDomain,
    paymentRows.map((row) => row.caseId),
  );
  const caseProfileById = new Map(
    caseProfiles.map((profile) => [Number(profile.caseId), profile]),
  );

  return paymentRows
    .filter((row) => isLegacyRoiPaymentRow(row, caseProfileById.get(Number(row.caseId)) || null))
    .map((row) => {
      const caseProfile = caseProfileById.get(Number(row.caseId)) || null;
      return {
        ...row,
        sourceName: caseProfile?.sourceName || row.sourceName || "Unknown",
        sourceChannel: caseProfile?.sourceChannel || row.sourceChannel || null,
      };
    });
}

async function resolveMetricsCollection(collectionName, match = {}) {
  const mirrorCollection = getMirrorDb().collection(buildMirrorCollectionName(collectionName));
  const hasMirrorRows = await mirrorCollection.countDocuments(match, { limit: 1 });
  if (hasMirrorRows > 0) {
    return {
      collection: mirrorCollection,
      source: "mirror",
    };
  }

  return {
    collection: getLegacyDb().collection(collectionName),
    source: "legacy",
  };
}

async function getLatestLegacySummaryDate(domain) {
  return getLatestLegacyMetricDate(domain);
}

async function getLatestLegacyMetricDate(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [spendCollection, paymentCollection, callCollection] = await Promise.all([
    resolveMetricsCollection("dailyspends", { domain: normalizedDomain }),
    resolveMetricsCollection("dailypaymentsummaries", { domain: normalizedDomain }),
    resolveMetricsCollection("rb_dailycallstats", {}),
  ]);
  const [spendRow, paymentRow, callRow] = await Promise.all([
    spendCollection.collection.find({ domain: normalizedDomain }).sort({ date: -1 }).limit(1).next(),
    paymentCollection.collection.find({ domain: normalizedDomain }).sort({ date: -1 }).limit(1).next(),
    callCollection.collection.find({}).sort({ date: -1 }).limit(1).next(),
  ]);

  return [spendRow?.date, paymentRow?.date, callRow?.date]
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
}

async function buildLegacyMetricsWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const latestDate = await getLatestLegacyMetricDate(normalizedDomain);
  const [spendCollection, paymentCollection, callCollection, alertCollection] = await Promise.all([
    resolveMetricsCollection("dailyspends", { domain: normalizedDomain }),
    resolveMetricsCollection("dailypaymentsummaries", { domain: normalizedDomain }),
    resolveMetricsCollection("rb_dailycallstats", {}),
    resolveMetricsCollection("rb_paymentalerts", { domain: normalizedDomain, textSentAt: null }),
  ]);

  const [dailySummaryWorkspace, lifetimeSourcesWorkspace, dailySpendAgg, dailyCallAgg] = latestDate
    ? await Promise.all([
      buildLegacyDailySummaryWorkspace(normalizedDomain, { date: latestDate }),
      buildLegacyMetricSourcesWorkspace(normalizedDomain),
      spendCollection.collection.aggregate([
        {
          $match: {
            domain: normalizedDomain,
            date: latestDate,
          },
        },
        {
          $group: {
            _id: null,
            spend: { $sum: { $ifNull: ["$spend", 0] } },
          },
        },
      ]).toArray(),
      callCollection.collection.aggregate([
        {
          $match: {
            date: latestDate,
          },
        },
        {
          $group: {
            _id: null,
            calls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          },
        },
      ]).toArray(),
    ])
    : [{ rows: [] }, { rows: [] }, [], []];

  const [dailyRoiPaymentRows, lifetimeRoiPaymentRows] = await Promise.all([
    latestDate
      ? listLegacyRoiPaymentRows(normalizedDomain, paymentCollection, { date: latestDate })
      : [],
    listLegacyRoiPaymentRows(normalizedDomain, paymentCollection),
  ]);

  const lifetimeSpendAggregation = await spendCollection.collection.aggregate([
    { $match: { domain: normalizedDomain } },
    {
      $group: {
        _id: null,
        spend: { $sum: { $ifNull: ["$spend", 0] } },
      },
    },
  ]).toArray();

  const lifetimeCallAggregation = await callCollection.collection.aggregate([
    {
      $group: {
        _id: null,
        calls: { $sum: { $ifNull: ["$totalCalls", 0] } },
      },
    },
  ]).toArray();

  const dailyLeads = sumLegacyLeadLikeRows(dailySummaryWorkspace?.rows || []);
  const dailySpend = dailySpendAgg[0]?.spend || 0;
  const dailyRevenue = dailyRoiPaymentRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
  const dailyCalls = dailyCallAgg[0]?.calls || 0;
  const lifetimeSpend = lifetimeSpendAggregation[0]?.spend || 0;
  const lifetimeRevenue = lifetimeRoiPaymentRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
  const lifetimeCalls = lifetimeCallAggregation[0]?.calls || 0;
  const lifetimeLeads = sumLegacyLeadLikeRows(lifetimeSourcesWorkspace?.rows || []);

  return {
    domain: normalizedDomain,
    snapshots: {
      daily: latestDate
        ? {
          date: latestDate,
          leads: dailyLeads,
          calls: dailyCalls,
          spend: dailySpend,
          revenue: dailyRevenue,
          roas: dailySpend > 0 ? dailyRevenue / dailySpend : null,
        }
        : null,
      lifetime: {
        date: "all-time",
        leads: lifetimeLeads,
        calls: lifetimeCalls,
        spend: lifetimeSpend,
        revenue: lifetimeRevenue,
        roas: lifetimeSpend > 0 ? lifetimeRevenue / lifetimeSpend : null,
      },
    },
    counts: {
      prospects: 0,
      caseProfiles: 0,
      payments: await paymentCollection.collection.countDocuments({ domain: normalizedDomain }),
      openReviewItems: await alertCollection.collection.countDocuments({
        domain: normalizedDomain,
        textSentAt: null,
      }),
    },
    latestDeepCutRun: null,
    dataSources: {
      dailyspends: spendCollection.source,
      dailypaymentsummaries: paymentCollection.source,
      rb_dailycallstats: callCollection.source,
      rb_paymentalerts: alertCollection.source,
    },
  };
}

async function buildLegacyMetricSourcesWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const spendMatch = { domain: normalizedDomain, ...buildDateRangeMatch(filters) };
  const paymentMatch = { domain: normalizedDomain, ...buildDateRangeMatch(filters) };
  const callMatch = applyPieceFilters({ ...buildDateRangeMatch(filters) }, filters);
  const [spendCollection, paymentCollection, callCollection] = await Promise.all([
    resolveMetricsCollection("dailyspends", spendMatch),
    resolveMetricsCollection("dailypaymentsummaries", paymentMatch),
    resolveMetricsCollection("rb_dailycallstats", callMatch),
  ]);

  const [spendRows, paymentRows, callRows] = await Promise.all([
    spendCollection.collection.aggregate([
      { $match: spendMatch },
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
    ]).toArray(),
    listLegacyRoiPaymentRows(normalizedDomain, paymentCollection, buildDateRangeMatch(filters)),
    callCollection.collection.aggregate([
      { $match: callMatch },
      {
        $group: {
          _id: { source: "$piece", channel: "$channel" },
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          uniqueCallers: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
        },
      },
    ]).toArray(),
  ]);

  const bySource = new Map();

  for (const row of spendRows) {
    const source = row._id?.source || "Unknown";
    bySource.set(source, {
      ...createLegacySourceRow(source, row._id?.channel || null),
      spend: row.spend || 0,
      pieces: row.pieces || 0,
      impressions: row.impressions || 0,
      clicks: row.clicks || 0,
      leadsReported: row.leadsReported || 0,
    });
  }

  for (const row of paymentRows) {
    const source = row.sourceName || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, createLegacySourceRow(source, row.sourceChannel || null));
    }
    const entry = bySource.get(source);
    entry.payments += Number(row.amount || 0);
    entry.initialPayments += row.type === "initial" ? Number(row.amount || 0) : 0;
    entry.initialPaymentCount += row.type === "initial" ? 1 : 0;
    entry.paymentCount = entry.initialPaymentCount;
    entry.channel = entry.channel || row.sourceChannel || null;
  }

  for (const row of callRows) {
    const source = row._id?.source || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, createLegacySourceRow(source, row._id?.channel || null));
    }
    const entry = bySource.get(source);
    entry.totalCalls += row.totalCalls || 0;
    entry.uniqueCallers += row.uniqueCallers || 0;
    entry.callsOver5 += row.callsOver5 || 0;
    entry.channel = entry.channel || row._id?.channel || null;
    if (String(entry.channel || "").toLowerCase().includes("mail")) {
      entry.leadsReported = Math.max(Number(entry.leadsReported || 0), Number(entry.uniqueCallers || 0));
    }
  }

  for (const row of listManualMetricSourceRows(normalizedDomain, filters)) {
    const source = row.source || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, createLegacySourceRow(source, row.channel || null));
    }
    const entry = bySource.get(source);
    entry.channel = entry.channel || row.channel || null;
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
    entry.count += Number(row.count || 0);
  }

  return {
    domain: normalizedDomain,
    dataSources: {
      dailyspends: spendCollection.source,
      dailypaymentsummaries: paymentCollection.source,
      rb_dailycallstats: callCollection.source,
    },
    rows: [...bySource.values()]
      .map((row) => ({
        ...row,
        roas: row.spend > 0 ? row.payments / row.spend : null,
      }))
      .sort((left, right) => (right.spend + right.payments) - (left.spend + left.payments)),
  };
}

async function buildLegacyDailySummaryWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const date = String(filters.date || await getLatestLegacyMetricDate(normalizedDomain) || new Date().toISOString().slice(0, 10));
  const callMatch = applyPieceFilters({ date }, filters);
  const [spendCollection, paymentCollection, callCollection] = await Promise.all([
    resolveMetricsCollection("dailyspends", { domain: normalizedDomain, date }),
    resolveMetricsCollection("dailypaymentsummaries", { domain: normalizedDomain, date }),
    resolveMetricsCollection("rb_dailycallstats", callMatch),
  ]);
  const [spendRows, paymentRows, callRows] = await Promise.all([
    spendCollection.collection.find({
      domain: normalizedDomain,
      date,
    }).toArray(),
    listLegacyRoiPaymentRows(normalizedDomain, paymentCollection, { date }),
    callCollection.collection.find(callMatch).toArray(),
  ]);

  const merged = new Map();

  for (const row of spendRows) {
    const source = row.source || "Unknown";
    if (!merged.has(source)) {
      merged.set(source, createLegacyDailyRow(source, row.channel || null));
    }
    const entry = merged.get(source);
    entry.channel = entry.channel || row.channel || null;
    entry.spend += row.spend || 0;
    entry.pieces += row.pieces || 0;
    entry.impressions += row.impressions || 0;
    entry.clicks += row.clicks || 0;
    entry.leadsReported += row.leadsReported || 0;
  }

  for (const row of paymentRows) {
    const source = row.sourceName || "Unknown";
    if (!merged.has(source)) {
      merged.set(source, createLegacyDailyRow(source, row.sourceChannel || null));
    }
    const entry = merged.get(source);
    entry.channel = entry.channel || row.sourceChannel || null;
    entry.paid += row.amount || 0;
    entry.deals += row.type === "initial" ? 1 : 0;
    entry.initials += row.type === "initial" ? (row.amount || 0) : 0;
  }

  for (const row of callRows) {
    const source = row.piece || "Unknown";
    if (!merged.has(source)) {
      merged.set(source, createLegacyDailyRow(source, row.channel || null));
    }
    const entry = merged.get(source);
    entry.channel = entry.channel || row.channel || null;
    entry.calls += row.totalCalls || 0;
    entry.callsOver5 += row.callsOver5 || 0;
    if (String(entry.channel || "").toLowerCase().includes("mail")) {
      entry.leadsReported = Math.max(Number(entry.leadsReported || 0), Number(row.uniqueCallers || 0));
      entry.caseCount = Math.max(Number(entry.caseCount || 0), Number(row.uniqueCallers || 0));
    }
  }

  for (const row of listManualDailySummaryRows(normalizedDomain, date)) {
    const source = row.source || "Unknown";
    if (!merged.has(source)) {
      merged.set(source, createLegacyDailyRow(source, row.channel || null));
    }
    const entry = merged.get(source);
    entry.channel = entry.channel || row.channel || null;
    entry.spend += Number(row.spend || 0);
    entry.pieces += Number(row.pieces || 0);
    entry.impressions += Number(row.impressions || 0);
    entry.clicks += Number(row.clicks || 0);
    entry.leadsReported += Number(row.leadsReported || 0);
    entry.caseCount += Number(row.count || row.leadsReported || 0);
  }

  return {
    domain: normalizedDomain,
    date,
    dataSources: {
      dailyspends: spendCollection.source,
      dailypaymentsummaries: paymentCollection.source,
      rb_dailycallstats: callCollection.source,
    },
    rows: [...merged.values()].sort((left, right) => {
      const leftWeight = (left.paid || 0) + (left.spend || 0) + (left.calls || 0);
      const rightWeight = (right.paid || 0) + (right.spend || 0) + (right.calls || 0);
      return rightWeight - leftWeight;
    }),
  };
}

async function buildLegacyMailCostWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const match = {
    domain: normalizedDomain,
    channel: "mailer",
    ...buildDateRangeMatch(filters),
  };
  const spendCollection = await resolveMetricsCollection("dailyspends", match);

  const [totalsAgg, byPiece, rows] = await Promise.all([
    spendCollection.collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          spend: { $sum: { $ifNull: ["$spend", 0] } },
          pieces: { $sum: { $ifNull: ["$pieces", 0] } },
        },
      },
    ]).toArray(),
    spendCollection.collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: { source: "$source", phone: "$phone" },
          totalSpend: { $sum: { $ifNull: ["$spend", 0] } },
          totalPieces: { $sum: { $ifNull: ["$pieces", 0] } },
          drops: { $sum: 1 },
          firstDate: { $min: "$date" },
          lastDate: { $max: "$date" },
        },
      },
      { $sort: { totalSpend: -1 } },
    ]).toArray(),
    spendCollection.collection.find(match).sort({ date: -1, updatedAt: -1 }).limit(Math.min(Number(filters.limit) || 200, 500)).toArray(),
  ]);

  return {
    domain: normalizedDomain,
    dataSources: {
      dailyspends: spendCollection.source,
    },
    totals: totalsAgg[0] || { spend: 0, pieces: 0 },
    byPiece,
    rows,
  };
}

async function buildLegacyCallrailWorkspace(filters = {}) {
  const match = applyPieceFilters(buildDateRangeMatch(filters), filters);
  if (filters.channel) {
    match.channel = String(filters.channel).trim().toLowerCase();
  }
  const callCollection = await resolveMetricsCollection("rb_dailycallstats", match);

  const [summary, rows] = await Promise.all([
    callCollection.collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$channel",
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
          callsOver2: { $sum: { $ifNull: ["$callsOver2", 0] } },
          totalDuration: { $sum: { $ifNull: ["$totalDuration", 0] } },
          uniqueCallers: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
          pieces: { $addToSet: "$piece" },
        },
      },
      { $sort: { totalCalls: -1 } },
    ]).toArray(),
    callCollection.collection.aggregate([
      { $match: match },
      {
        $group: {
          _id: { piece: "$piece", channel: "$channel" },
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
          callsOver2: { $sum: { $ifNull: ["$callsOver2", 0] } },
          totalDuration: { $sum: { $ifNull: ["$totalDuration", 0] } },
          uniqueCallers: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
          days: { $sum: 1 },
        },
      },
      { $sort: { totalCalls: -1, "_id.piece": 1 } },
    ]).toArray(),
  ]);

  return {
    date: filters.date || null,
    from: filters.from || null,
    to: filters.to || null,
    dataSources: {
      rb_dailycallstats: callCollection.source,
    },
    summary,
    rows,
  };
}

async function buildLegacyRedlineWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const requestedStatus = String(filters.status || "pending").toLowerCase();
  const alertCollection = await resolveMetricsCollection("rb_paymentalerts", { domain: normalizedDomain });

  const [allAlerts, reviewRedlines] = await Promise.all([
    alertCollection.collection.find({ domain: normalizedDomain }).sort({ paymentDate: -1, createdAt: -1 }).limit(Math.min(Number(filters.limit) || 100, 250)).toArray(),
    getMirrorDb().collection("controlplanereviewqueueitems").find({
      domain: normalizedDomain,
      category: "redline",
    }).sort({ createdAt: -1 }).limit(50).toArray().catch(() => []),
  ]);

  const pendingAlerts = allAlerts.filter((alert) => !alert.textSentAt);
  const sentAlerts = allAlerts.filter((alert) => !!alert.textSentAt);
  const suppressedAlerts = allAlerts.filter((alert) => Boolean(alert.suppressedAt));

  let alerts = pendingAlerts;
  if (requestedStatus === "sent") alerts = sentAlerts;
  if (requestedStatus === "suppressed") alerts = suppressedAlerts;

  return {
    domain: normalizedDomain,
    dataSources: {
      rb_paymentalerts: alertCollection.source,
    },
    counts: {
      pending: pendingAlerts.length,
      suppressed: suppressedAlerts.length,
      sent: sentAlerts.length,
      reviewRedlines: reviewRedlines.length,
    },
    alerts,
    reviewItems: reviewRedlines,
  };
}

module.exports = {
  buildLegacyCallrailWorkspace,
  buildLegacyDailySummaryWorkspace,
  buildLegacyMailCostWorkspace,
  buildLegacyMetricSourcesWorkspace,
  buildLegacyMetricsWorkspace,
  buildLegacyRedlineWorkspace,
};
