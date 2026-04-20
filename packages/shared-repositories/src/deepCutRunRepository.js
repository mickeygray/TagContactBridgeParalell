"use strict";

const { DeepCutRun } = require("../../shared-models/src");

async function createDeepCutRun(payload) {
  return DeepCutRun.create(payload);
}

async function listDeepCutRuns(domain, filters = {}) {
  const query = {};
  if (domain) query.domain = String(domain).toUpperCase();
  if (filters.runType) query.runType = filters.runType;
  if (filters.status) query.status = filters.status;

  const limit = Math.min(Number(filters.limit) || 20, 100);
  return DeepCutRun.find(query)
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean();
}

async function getLatestDeepCutRun(domain, runType = "daily-deep-cut") {
  return DeepCutRun.findOne({
    domain: String(domain).toUpperCase(),
    runType,
  })
    .sort({ startedAt: -1 })
    .lean();
}

async function getDeepCutRunById(id) {
  return DeepCutRun.findById(id).lean();
}

async function updateDeepCutRun(id, update = {}) {
  return DeepCutRun.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  ).lean();
}

module.exports = {
  createDeepCutRun,
  getDeepCutRunById,
  getLatestDeepCutRun,
  listDeepCutRuns,
  updateDeepCutRun,
};
