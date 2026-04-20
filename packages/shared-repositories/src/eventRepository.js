"use strict";

const { EventRecord } = require("../../shared-models/src");

function buildEventQuery(filters = {}) {
  const query = {};

  if (filters.status) query.status = filters.status;
  if (filters.eventType) query.eventType = filters.eventType;
  if (filters.sourceService) query.sourceService = filters.sourceService;
  if (filters.aggregateId) query.aggregateId = filters.aggregateId;

  return query;
}

async function findEvents(filters = {}) {
  return EventRecord.find(buildEventQuery(filters))
    .sort({ createdAt: -1 })
    .limit(filters.limit || 100)
    .lean();
}

async function findEventById(eventId) {
  return EventRecord.findById(eventId);
}

async function findEventByDedupeKey(sourceService, dedupeKey) {
  return EventRecord.findOne({
    sourceService,
    dedupeKey,
  });
}

async function createEventRecord(doc) {
  return EventRecord.create(doc);
}

module.exports = {
  buildEventQuery,
  createEventRecord,
  findEventByDedupeKey,
  findEventById,
  findEvents,
};
