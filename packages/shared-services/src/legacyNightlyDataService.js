"use strict";

// Legacy-DB reads for the nightly close. The Parallel collections are
// at near-zero volume during cutover — the actual day's calls,
// payment alerts, and spend rows still land in the old `test` DB
// under `rb_*` and `daily*` collections. This module surfaces those
// as same-shape payloads the nightly senders already expect, so the
// emails can carry real numbers tonight without waiting for full
// Parallel ingestion.
//
// Read-only: all calls hit the legacy DB via mongoose's `useDb`. We
// never write back to legacy.

const mongoose = require("mongoose");
const {
  listLegacyContactActivityDocs,
} = require("./legacyContactActivityService");

function getLegacyDbName() {
  return String(process.env.LEGACY_APP_DB_NAME || "test").trim() || "test";
}

function getLegacyDb() {
  return mongoose.connection.useDb(getLegacyDbName(), { useCache: true });
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function buildDayWindow(dateKey, timeZone = "America/Los_Angeles") {
  // Build PT day window using the existing timezone helper for
  // consistency. Local fallback if helper isn't available.
  try {
    const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");
    return buildTimezoneDateWindow(dateKey, timeZone);
  } catch {
    const start = new Date(`${dateKey}T00:00:00`);
    const end = new Date(`${dateKey}T23:59:59.999`);
    return { start, end };
  }
}

// ── 1. Today's calls — legacy rb_contactactivities ─────────────────
//
// Returns docs in the same column shape `nightlyCsvBuilders.buildCallLogCsv`
// already accepts: callStartTime, agentName, direction, phone,
// phoneFormatted, callerName, durationSeconds, disposition,
// sourceName, sourceChannel, caseId, callScore.
async function listLegacyTodaysCalls(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildDayWindow(dateKey, timeZone);
  const docs = await listLegacyContactActivityDocs({
    domain: normalizeDomain(domain),
    from: start,
    to: end,
    limit: 5000,
  });
  return docs.map((doc) => ({
    callStartTime: doc.callStartTime || doc.createdAt || null,
    createdAt: doc.createdAt || null,
    agentName: doc.agentName || null,
    direction: doc.direction || null,
    phone: doc.phone || null,
    phoneFormatted: doc.phone || null,
    callerName: doc.caseMatch?.name || null,
    contactName: doc.caseMatch?.name || null,
    durationSeconds: toNumber(doc.durationSeconds),
    disposition: doc.disposition || null,
    sourceName: doc.caseMatch?.sourceName || null,
    sourceChannel: doc.caseMatch?.sourceChannel || null,
    caseId: doc.caseMatch?.caseId || null,
    callScore: doc.callScore || null,
  }));
}

// ── 2. Today's payment alerts — legacy rb_paymentalerts ────────────
async function listLegacyTodaysPaymentAlerts(domain, dateKey) {
  const collection = getLegacyDb().collection("rb_paymentalerts");
  const docs = await collection.find({
    domain: normalizeDomain(domain),
    paymentDate: dateKey,
  }).limit(200).toArray();
  return docs.map((d) => ({
    domain: d.domain,
    caseId: d.caseId,
    name: d.name || "",
    phone: d.phone || "",
    phoneFormatted: d.phoneFormatted || d.phone || "",
    declinedAmount: toNumber(d.declinedAmount),
    attempts: toNumber(d.attempts),
    lastTransactionStatus: d.lastTransactionStatus || "UNKNOWN",
    lastTransactionComment: d.lastTransactionComment || "",
    paymentDate: d.paymentDate || dateKey,
    statusId: d.statusId || null,
    detectedAt: d.detectedAt || null,
  }));
}

// ── 3. Today's spend by channel — legacy dailyspends ───────────────
async function summarizeLegacySpendByChannel(domain, dateKey) {
  const rows = await getLegacyDb().collection("dailyspends").aggregate([
    { $match: { domain: normalizeDomain(domain), date: String(dateKey) } },
    {
      $group: {
        _id: "$channel",
        spend: { $sum: { $ifNull: ["$spend", 0] } },
        pieces: { $sum: { $ifNull: ["$pieces", 0] } },
        impressions: { $sum: { $ifNull: ["$impressions", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
        leadsReported: { $sum: { $ifNull: ["$leadsReported", 0] } },
      },
    },
  ]).toArray();
  return rows.map((r) => ({
    channel: r._id || "unknown",
    spend: toNumber(r.spend),
    pieces: toNumber(r.pieces),
    impressions: toNumber(r.impressions),
    clicks: toNumber(r.clicks),
    leadsReported: toNumber(r.leadsReported),
  })).sort((a, b) => b.spend - a.spend);
}

async function getLegacySpendTotals(domain, dateKey) {
  const rows = await getLegacyDb().collection("dailyspends").aggregate([
    { $match: { domain: normalizeDomain(domain), date: String(dateKey) } },
    {
      $group: {
        _id: null,
        spend: { $sum: { $ifNull: ["$spend", 0] } },
        pieces: { $sum: { $ifNull: ["$pieces", 0] } },
        impressions: { $sum: { $ifNull: ["$impressions", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
        leadsReported: { $sum: { $ifNull: ["$leadsReported", 0] } },
        rows: { $sum: 1 },
      },
    },
  ]).toArray();
  const row = rows[0] || {};
  return {
    total: toNumber(row.spend),
    pieces: toNumber(row.pieces),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    leadsReported: toNumber(row.leadsReported),
    rows: toNumber(row.rows),
  };
}

// ── 4. Today's deals by source — legacy dailypaymentsummaries ──────
//
// Counts each `type === "initial"` row as one deal. `dailypaymentsummaries`
// stores a row per case payment with `sourceName` already enriched, so
// the group-by collapses cleanly without a join.
async function summarizeLegacyDealsBySource(domain, dateKey) {
  const rows = await getLegacyDb().collection("dailypaymentsummaries").aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        date: String(dateKey),
        type: "initial",
      },
    },
    {
      $group: {
        _id: { source: "$sourceName", channel: "$sourceChannel" },
        deals: { $sum: 1 },
        initialPayments: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
    { $sort: { deals: -1 } },
  ]).toArray();

  // Total collected (initial + recurring on the same day) per source.
  const allRows = await getLegacyDb().collection("dailypaymentsummaries").aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        date: String(dateKey),
      },
    },
    {
      $group: {
        _id: "$sourceName",
        totalCollected: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]).toArray();
  const collectedBySource = new Map(
    allRows.map((r) => [r._id || "Unknown", toNumber(r.totalCollected)]),
  );

  return rows.map((r) => ({
    source: r._id?.source || "Unknown",
    channel: r._id?.channel || null,
    deals: toNumber(r.deals),
    initialPayments: toNumber(r.initialPayments),
    totalCollected: collectedBySource.get(r._id?.source || "Unknown") || 0,
  }));
}

async function getLegacyPaymentTotals(domain, dateKey) {
  const rows = await getLegacyDb().collection("dailypaymentsummaries").aggregate([
    { $match: { domain: normalizeDomain(domain), date: String(dateKey) } },
    {
      $group: {
        _id: "$type",
        total: { $sum: { $ifNull: ["$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();
  let initialAmount = 0, initialCount = 0, recurringAmount = 0, recurringCount = 0;
  for (const r of rows) {
    const t = String(r._id || "").toLowerCase();
    if (t === "initial") {
      initialAmount += toNumber(r.total);
      initialCount += toNumber(r.count);
    } else {
      recurringAmount += toNumber(r.total);
      recurringCount += toNumber(r.count);
    }
  }
  return {
    totalAmount: initialAmount + recurringAmount,
    totalCount: initialCount + recurringCount,
    initialAmount, initialCount,
    recurringAmount, recurringCount,
  };
}

async function getLegacyMtdPaymentTotals(domain, monthStartKey, monthEndKey) {
  const rows = await getLegacyDb().collection("dailypaymentsummaries").aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        date: { $gte: String(monthStartKey), $lte: String(monthEndKey) },
      },
    },
    {
      $group: {
        _id: "$type",
        total: { $sum: { $ifNull: ["$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();
  let initialAmount = 0, initialCount = 0, recurringAmount = 0, recurringCount = 0;
  for (const r of rows) {
    const t = String(r._id || "").toLowerCase();
    if (t === "initial") {
      initialAmount += toNumber(r.total);
      initialCount += toNumber(r.count);
    } else {
      recurringAmount += toNumber(r.total);
      recurringCount += toNumber(r.count);
    }
  }
  return {
    totalAmount: initialAmount + recurringAmount,
    totalCount: initialCount + recurringCount,
    initialAmount, initialCount,
    recurringAmount, recurringCount,
  };
}

async function getLegacyMtdSpendTotals(domain, monthStartKey, monthEndKey) {
  const rows = await getLegacyDb().collection("dailyspends").aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        date: { $gte: String(monthStartKey), $lte: String(monthEndKey) },
      },
    },
    {
      $group: {
        _id: null,
        spend: { $sum: { $ifNull: ["$spend", 0] } },
        pieces: { $sum: { $ifNull: ["$pieces", 0] } },
        impressions: { $sum: { $ifNull: ["$impressions", 0] } },
        clicks: { $sum: { $ifNull: ["$clicks", 0] } },
        leadsReported: { $sum: { $ifNull: ["$leadsReported", 0] } },
        rows: { $sum: 1 },
      },
    },
  ]).toArray();
  const r = rows[0] || {};
  return {
    total: toNumber(r.spend),
    pieces: toNumber(r.pieces),
    impressions: toNumber(r.impressions),
    clicks: toNumber(r.clicks),
    leadsReported: toNumber(r.leadsReported),
    rows: toNumber(r.rows),
  };
}

// ── 5. Today's status transitions — legacy rb_caseprofiles ─────────
//
// rb_caseprofiles tracks `convertedAt` (became deal),
// `postDateDetectedAt` (became post-date), and the `statusCategory`
// for the current state. We approximate the legacy "status changes
// today" tile by counting profiles whose `convertedAt`,
// `postDateDetectedAt`, or `lastSweepAt` falls in the day window.
async function summarizeLegacyTransitionsBySource(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildDayWindow(dateKey, timeZone);
  const collection = getLegacyDb().collection("rb_caseprofiles");

  // Pull the candidates: profiles touched today by any state change.
  const docs = await collection.find({
    domain: normalizeDomain(domain),
    $or: [
      { convertedAt: { $gte: start, $lte: end } },
      { postDateDetectedAt: { $gte: start, $lte: end } },
      // statusCategory dnc is destructive in legacy — there's no
      // dncDetectedAt, so use lastSweepAt as a proxy when category=dnc.
      { lastSweepAt: { $gte: start, $lte: end }, statusCategory: "dnc" },
    ],
  }, {
    projection: {
      caseId: 1,
      sourceName: 1,
      sourceChannel: 1,
      statusCategory: 1,
      convertedAt: 1,
      postDateDetectedAt: 1,
      isRedline: 1,
      lastSweepAt: 1,
    },
  }).limit(2000).toArray();

  const bySource = new Map();
  for (const doc of docs) {
    const source = doc.sourceName || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, { source, contacted: 0, deal: 0, postdate: 0, dnc: 0, redline: 0 });
    }
    const target = bySource.get(source);
    target.contacted += 1;
    const c = String(doc.statusCategory || "").toLowerCase();
    if (c === "client" || c.startsWith("tier")) target.deal += 1;
    else if (c === "postdate") target.postdate += 1;
    else if (c === "dnc") target.dnc += 1;
    if (doc.isRedline) target.redline += 1;
  }
  return [...bySource.values()].sort((a, b) => b.contacted - a.contacted);
}

// ── 6. Today's leads + management snapshot — combine sources ───────
//
// rb_caseprofiles created today = "leads in" (legacy auto-creates a
// profile when a new lead lands). Calls roll up off rb_dailycallstats.
async function buildLegacyManagementSnapshot(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildDayWindow(dateKey, timeZone);
  const profilesCollection = getLegacyDb().collection("rb_caseprofiles");

  const [leadAgg, callAgg, spendTotals, paymentTotals] = await Promise.all([
    profilesCollection.aggregate([
      {
        $match: {
          domain: normalizeDomain(domain),
          createdAt: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: "$sourceName",
          count: { $sum: 1 },
        },
      },
    ]).toArray(),
    getLegacyDb().collection("rb_dailycallstats").aggregate([
      { $match: { date: String(dateKey) } },
      {
        $group: {
          _id: "$channel",
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
          uniqueCallers: { $sum: { $ifNull: ["$uniqueCallers", 0] } },
        },
      },
    ]).toArray(),
    getLegacySpendTotals(domain, dateKey),
    getLegacyPaymentTotals(domain, dateKey),
  ]);

  const leadEntries = leadAgg.map((r) => ({
    source: r._id || "Unknown",
    count: toNumber(r.count),
  })).sort((a, b) => b.count - a.count);
  const leadsTotal = leadEntries.reduce((s, r) => s + r.count, 0);

  const byChannel = callAgg.map((r) => ({
    channel: r._id || "unknown",
    totalCalls: toNumber(r.totalCalls),
    callsOver5: toNumber(r.callsOver5),
    uniqueCallers: toNumber(r.uniqueCallers),
  }));
  const callsTotal = byChannel.reduce((s, r) => s + r.totalCalls, 0);
  const callsOver5 = byChannel.reduce((s, r) => s + r.callsOver5, 0);

  // Pending redlines today — `rb_paymentalerts` rows for this date
  // that haven't been textSentAt-stamped.
  const pendingRedlines = await getLegacyDb()
    .collection("rb_paymentalerts")
    .countDocuments({
      domain: normalizeDomain(domain),
      paymentDate: dateKey,
      textSentAt: null,
    });

  return {
    date: dateKey,
    spend: spendTotals,
    leads: { total: leadsTotal, entries: leadEntries },
    payments: paymentTotals,
    calls: { total: callsTotal, callsOver5, byChannel },
    scores: { totalScoredCalls: 0, bySource: [] }, // legacy doesn't pre-aggregate scores
    alerts: { pendingRedlines, reviewRedlines: 0, unresolvedHourlyJobs: 0 },
  };
}

async function buildLegacyMonthToDateSnapshot(domain, dateKey) {
  const monthStart = `${dateKey.slice(0, 7)}-01`;
  const [spendTotals, paymentTotals, leadAgg, callAgg] = await Promise.all([
    getLegacyMtdSpendTotals(domain, monthStart, dateKey),
    getLegacyMtdPaymentTotals(domain, monthStart, dateKey),
    getLegacyDb().collection("rb_caseprofiles").aggregate([
      {
        $match: {
          domain: normalizeDomain(domain),
          createdAt: {
            $gte: new Date(`${monthStart}T00:00:00`),
            $lte: new Date(`${dateKey}T23:59:59.999`),
          },
        },
      },
      {
        $group: { _id: "$sourceName", count: { $sum: 1 } },
      },
    ]).toArray(),
    getLegacyDb().collection("rb_dailycallstats").aggregate([
      { $match: { date: { $gte: monthStart, $lte: String(dateKey) } } },
      {
        $group: {
          _id: "$channel",
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
        },
      },
    ]).toArray(),
  ]);

  const leadEntries = leadAgg.map((r) => ({
    source: r._id || "Unknown",
    count: toNumber(r.count),
  })).sort((a, b) => b.count - a.count);

  const byChannel = callAgg.map((r) => ({
    channel: r._id || "unknown",
    totalCalls: toNumber(r.totalCalls),
    callsOver5: toNumber(r.callsOver5),
  }));

  return {
    monthStart,
    monthEnd: dateKey,
    leads: {
      total: leadEntries.reduce((s, r) => s + r.count, 0),
      entries: leadEntries,
    },
    spend: spendTotals,
    payments: paymentTotals,
    calls: {
      total: byChannel.reduce((s, r) => s + r.totalCalls, 0),
      callsOver5: byChannel.reduce((s, r) => s + r.callsOver5, 0),
      byChannel,
    },
  };
}

module.exports = {
  listLegacyTodaysCalls,
  listLegacyTodaysPaymentAlerts,
  summarizeLegacySpendByChannel,
  summarizeLegacyDealsBySource,
  summarizeLegacyTransitionsBySource,
  buildLegacyManagementSnapshot,
  buildLegacyMonthToDateSnapshot,
  getLegacySpendTotals,
  getLegacyPaymentTotals,
  getLegacyMtdSpendTotals,
  getLegacyMtdPaymentTotals,
};
