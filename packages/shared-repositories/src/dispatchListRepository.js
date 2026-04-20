"use strict";

const { DispatchList } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

async function createDispatchList(input = {}) {
  return DispatchList.create({
    ...input,
    domain: normalizeDomain(input.domain),
  });
}

async function findDispatchListById(id) {
  return DispatchList.findById(id).lean();
}

async function listDispatchLists(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
  };

  if (filters.family) query.family = filters.family;
  if (filters.subtype) query.subtype = filters.subtype;
  if (filters.channel) query.channel = filters.channel;
  if (filters.mode) query.mode = filters.mode;
  if (filters.status) query.status = filters.status;

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return DispatchList.find(query)
    .sort({ builtAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

async function updateDispatchList(id, update = {}) {
  return DispatchList.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  );
}

async function markDispatchListQueued(id, eventId) {
  return updateDispatchList(id, {
    status: "queued",
    queuedAt: new Date(),
    eventId: eventId ? String(eventId) : null,
  });
}

async function markDispatchListConsuming(id) {
  return updateDispatchList(id, {
    status: "consuming",
  });
}

async function markDispatchListCompleted(id, result = {}) {
  return updateDispatchList(id, {
    status: "completed",
    consumedAt: new Date(),
    "stats.attemptedCount": Number(result.attemptedCount || 0),
    "stats.successCount": Number(result.successCount || 0),
    "stats.failedCount": Number(result.failedCount || 0),
    lastResult: result,
  });
}

async function markDispatchListFailed(id, result = {}) {
  return updateDispatchList(id, {
    status: "failed",
    "stats.attemptedCount": Number(result.attemptedCount || 0),
    "stats.successCount": Number(result.successCount || 0),
    "stats.failedCount": Number(result.failedCount || 0),
    lastResult: result,
  });
}

module.exports = {
  createDispatchList,
  findDispatchListById,
  listDispatchLists,
  markDispatchListCompleted,
  markDispatchListConsuming,
  markDispatchListFailed,
  markDispatchListQueued,
  updateDispatchList,
};
