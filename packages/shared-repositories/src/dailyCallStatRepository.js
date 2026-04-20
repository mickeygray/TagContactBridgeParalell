"use strict";

const { DailyCallStat } = require("../../shared-models/src");

function normalizeDomainChannel(channel) {
  return channel ? String(channel).trim().toLowerCase() : null;
}

function buildDateRangeQuery(filters = {}) {
  if (!filters.from && !filters.to && !filters.date) return {};
  if (filters.date) return { date: String(filters.date) };

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return { date: range };
}

async function listDailyCallStats(filters = {}) {
  const query = {
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = normalizeDomainChannel(filters.channel);
  if (filters.piece) query.piece = filters.piece;

  const limit = Math.min(Number(filters.limit) || 200, 1000);
  return DailyCallStat.find(query)
    .sort({ date: -1, totalCalls: -1, piece: 1 })
    .limit(limit)
    .lean();
}

async function summarizeCallStats(filters = {}) {
  const query = {
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = normalizeDomainChannel(filters.channel);

  return DailyCallStat.aggregate([
    { $match: query },
    {
      $group: {
        _id: { piece: "$piece", channel: "$channel" },
        totalCalls: { $sum: "$totalCalls" },
        callsOver5: { $sum: "$callsOver5" },
        callsOver2: { $sum: "$callsOver2" },
        totalDuration: { $sum: "$totalDuration" },
        uniqueCallers: { $sum: "$uniqueCallers" },
        days: { $sum: 1 },
      },
    },
    { $sort: { totalCalls: -1, "_id.piece": 1 } },
  ]);
}

async function summarizeCallsByChannel(filters = {}) {
  const query = {
    ...buildDateRangeQuery(filters),
  };

  return DailyCallStat.aggregate([
    { $match: query },
    {
      $group: {
        _id: "$channel",
        totalCalls: { $sum: "$totalCalls" },
        callsOver5: { $sum: "$callsOver5" },
        callsOver2: { $sum: "$callsOver2" },
        totalDuration: { $sum: "$totalDuration" },
        uniqueCallers: { $sum: "$uniqueCallers" },
        pieces: { $addToSet: "$piece" },
      },
    },
    { $sort: { totalCalls: -1, _id: 1 } },
  ]);
}

module.exports = {
  listDailyCallStats,
  summarizeCallStats,
  summarizeCallsByChannel,
};
