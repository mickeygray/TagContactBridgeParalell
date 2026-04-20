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

module.exports = {
  getSpendTotals,
  listSpendEntries,
  summarizeMailCosts,
  summarizeSpendBySource,
};
