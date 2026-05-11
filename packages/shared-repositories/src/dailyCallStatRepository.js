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

/**
 * Apply cross-tenant piece filtering. Because DailyCallStat is
 * cross-company by design (one CallRail account per platform), callers
 * pass `excludePieces: [string[]]` (piece names owned by other domains)
 * so we drop rows that explicitly belong elsewhere. Pieces with no
 * ownership stay visible everywhere — that's the intended cross-tenant
 * default for mail pieces.
 */
function applyPieceFilters(query, filters) {
  if (Array.isArray(filters.pieces) && filters.pieces.length > 0) {
    query.piece = { $in: filters.pieces };
  }
  if (Array.isArray(filters.excludePieces) && filters.excludePieces.length > 0) {
    query.piece = Object.assign(query.piece || {}, {
      $nin: filters.excludePieces,
    });
  }
  return query;
}

async function summarizeCallStats(filters = {}) {
  const query = {
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = normalizeDomainChannel(filters.channel);
  applyPieceFilters(query, filters);

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

  applyPieceFilters(query, filters);

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
