"use strict";

const { ReviewQueueItem } = require("../../shared-models/src");

async function createReviewQueueItem(payload) {
  return ReviewQueueItem.create(payload);
}

async function listReviewQueueItems(domain, filters = {}) {
  const query = {};
  if (domain) query.domain = String(domain).toUpperCase();
  if (filters.status) query.status = filters.status;
  if (filters.workflow) query.workflow = filters.workflow;
  if (filters.category) query.category = filters.category;
  if (filters.severity) query.severity = filters.severity;
  if (filters.caseId != null) query.caseId = Number(filters.caseId);

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return ReviewQueueItem.find(query)
    .sort({ happenedAt: -1 })
    .limit(limit)
    .lean();
}

async function countReviewQueueItems(domain, filters = {}) {
  const query = {};
  if (domain) query.domain = String(domain).toUpperCase();
  if (filters.status) query.status = filters.status;
  if (filters.workflow) query.workflow = filters.workflow;
  if (filters.category) query.category = filters.category;
  if (filters.severity) query.severity = filters.severity;
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  return ReviewQueueItem.countDocuments(query);
}

async function updateReviewQueueItem(id, update = {}) {
  return ReviewQueueItem.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  ).lean();
}

module.exports = {
  countReviewQueueItems,
  createReviewQueueItem,
  listReviewQueueItems,
  updateReviewQueueItem,
};
