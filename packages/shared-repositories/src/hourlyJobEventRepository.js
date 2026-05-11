"use strict";

const { HourlyJobEvent } = require("../../shared-models/src");

function buildHourlyJobEventQuery(filters = {}) {
  const query = {};
  if (filters.lane) query.lane = filters.lane;
  if (filters.status) query.status = filters.status;
  if (filters.eventType) query.eventType = filters.eventType;
  if (filters.targetService) query.targetService = filters.targetService;
  if (filters.handlerKey) query.handlerKey = filters.handlerKey;
  if (filters.resolutionCheckKey) query.resolutionCheckKey = filters.resolutionCheckKey;
  if (filters.aggregateType) query.aggregateType = filters.aggregateType;
  if (filters.aggregateId) query.aggregateId = String(filters.aggregateId);
  if (filters.domain) query.domain = String(filters.domain).toUpperCase();
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.provideSummary != null) query.provideSummary = Boolean(filters.provideSummary);
  return query;
}

async function createHourlyJobEvent(payload) {
  return HourlyJobEvent.create(payload);
}

async function findHourlyJobEventById(id) {
  return HourlyJobEvent.findById(id);
}

async function findHourlyJobEventByDedupeKey(lane, dedupeKey) {
  return HourlyJobEvent.findOne({
    lane,
    dedupeKey,
  });
}

async function listHourlyJobEvents(filters = {}) {
  const limit = Math.min(Number(filters.limit) || 100, 500);
  return HourlyJobEvent.find(buildHourlyJobEventQuery(filters))
    .sort({ nextAttemptAt: 1, priority: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  buildHourlyJobEventQuery,
  createHourlyJobEvent,
  findHourlyJobEventByDedupeKey,
  findHourlyJobEventById,
  listHourlyJobEvents,
};
