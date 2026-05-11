"use strict";

const { SpendEntry } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildDateRangeQuery(filters = {}) {
  if (!filters.from && !filters.to && !filters.date) return {};
  if (filters.date) return { date: String(filters.date) };

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return { date: range };
}

async function listSpendEntries(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;
  if (filters.source) query.source = filters.source;
  if (filters.sheetId) query.sheetId = filters.sheetId;

  const limit = Math.min(Number(filters.limit) || 100, 500);
  return SpendEntry.find(query)
    .sort({ date: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
}

async function summarizeSpendBySource(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;

  return SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: { source: "$source", channel: "$channel" },
        spend: { $sum: "$spend" },
        pieces: { $sum: "$pieces" },
        impressions: { $sum: "$impressions" },
        clicks: { $sum: "$clicks" },
        leadsReported: { $sum: "$leadsReported" },
        rows: { $sum: 1 },
      },
    },
    { $sort: { spend: -1, "_id.source": 1 } },
  ]);
}

async function summarizeMailCosts(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    channel: "mailer",
    ...buildDateRangeQuery(filters),
  };

  return SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: { source: "$source", phone: "$phone" },
        totalSpend: { $sum: "$spend" },
        totalPieces: { $sum: "$pieces" },
        drops: { $sum: 1 },
        firstDate: { $min: "$date" },
        lastDate: { $max: "$date" },
      },
    },
    { $sort: { totalSpend: -1 } },
  ]);
}

async function getSpendTotals(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;

  const [row] = await SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        spend: { $sum: "$spend" },
        pieces: { $sum: "$pieces" },
        impressions: { $sum: "$impressions" },
        clicks: { $sum: "$clicks" },
        leadsReported: { $sum: "$leadsReported" },
        rows: { $sum: 1 },
      },
    },
  ]);

  return row || {
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leadsReported: 0,
    rows: 0,
  };
}

function buildSpendEntryIdentity(entry = {}) {
  const identity = {
    date: String(entry.date || ""),
    domain: normalizeDomain(entry.domain),
    channel: String(entry.channel || "").trim(),
    sheetId: entry.sheetId || null,
  };

  if (entry.broadcastId) {
    identity.broadcastId = String(entry.broadcastId);
  } else if (entry.jobNumber) {
    identity.jobNumber = String(entry.jobNumber);
  } else if (entry.metaAdId) {
    identity.metaAdId = String(entry.metaAdId);
  } else if (entry.adName || entry.adSet) {
    identity.campaign = String(entry.campaign || "");
    identity.adSet = String(entry.adSet || "");
    identity.adName = String(entry.adName || "");
  } else if (entry.campaign) {
    identity.campaign = String(entry.campaign);
  } else {
    identity.source = String(entry.source || "");
  }

  return identity;
}

async function upsertSpendEntry(entry = {}) {
  const identity = buildSpendEntryIdentity(entry);
  return SpendEntry.findOneAndUpdate(
    identity,
    { $set: { ...entry, domain: normalizeDomain(entry.domain), syncedAt: entry.syncedAt || new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function upsertSpendEntries(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const operations = entries.map((entry) => ({
    updateOne: {
      filter: buildSpendEntryIdentity(entry),
      update: {
        $set: {
          ...entry,
          domain: normalizeDomain(entry.domain),
          syncedAt: entry.syncedAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  return SpendEntry.bulkWrite(operations, { ordered: false });
}

module.exports = {
  buildSpendEntryIdentity,
  getSpendTotals,
  listSpendEntries,
  summarizeMailCosts,
  summarizeSpendBySource,
  upsertSpendEntries,
  upsertSpendEntry,
};
