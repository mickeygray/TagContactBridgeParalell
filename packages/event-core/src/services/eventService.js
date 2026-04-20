"use strict";

const EventRecord = require("../models/EventRecord");
const { eventRepository } = require("../../../shared-repositories/src");
const { EVENT_STATUS } = require("../constants");

function computeBackoffMs(attemptCount) {
  const base = 15 * 1000;
  return Math.min(base * Math.max(attemptCount, 1), 5 * 60 * 1000);
}

async function createEvent(input) {
  const doc = {
    eventType: input.eventType,
    sourceService: input.sourceService,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload || {},
    status: EVENT_STATUS.PENDING,
    dedupeKey: input.dedupeKey || null,
    nextAttemptAt: new Date(),
  };

  if (doc.dedupeKey) {
    const existing = await eventRepository.findEventByDedupeKey(
      doc.sourceService,
      doc.dedupeKey,
    );

    if (existing) {
      return { event: existing, deduped: true };
    }
  }

  const event = await eventRepository.createEventRecord(doc);
  return { event, deduped: false };
}

async function listEvents(filters = {}) {
  return eventRepository.findEvents(filters);
}

async function claimNextEvent(workerName, options = {}) {
  const now = new Date();
  const allowedEventTypes = Array.isArray(options.eventTypes)
    ? options.eventTypes.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  const query = {
    status: { $in: [EVENT_STATUS.PENDING, EVENT_STATUS.FAILED, EVENT_STATUS.REPLAYED] },
    nextAttemptAt: { $lte: now },
  };

  if (allowedEventTypes.length > 0) {
    query.eventType = { $in: allowedEventTypes };
  }

  return EventRecord.findOneAndUpdate(
    query,
    {
      $set: {
        status: EVENT_STATUS.PROCESSING,
        lastWorker: workerName,
      },
      $inc: { attemptCount: 1 },
      $push: {
        attempts: {
          worker: workerName,
          status: EVENT_STATUS.PROCESSING,
          startedAt: now,
        },
      },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      new: true,
    },
  );
}

async function markCompleted(eventId, workerName) {
  const now = new Date();
  const event = await eventRepository.findEventById(eventId);
  if (!event) return null;

  const lastAttempt = event.attempts[event.attempts.length - 1];
  if (lastAttempt) {
    lastAttempt.status = EVENT_STATUS.COMPLETED;
    lastAttempt.finishedAt = now;
  }

  event.status = EVENT_STATUS.COMPLETED;
  event.processedAt = now;
  event.lastError = null;
  event.lastWorker = workerName;
  await event.save();
  return event;
}

async function markFailed(eventId, workerName, error, maxAttempts = 3) {
  const now = new Date();
  const event = await eventRepository.findEventById(eventId);
  if (!event) return null;

  const exhausted = event.attemptCount >= maxAttempts;
  const nextStatus = exhausted ? EVENT_STATUS.DEAD_LETTER : EVENT_STATUS.FAILED;
  const lastAttempt = event.attempts[event.attempts.length - 1];
  if (lastAttempt) {
    lastAttempt.status = nextStatus;
    lastAttempt.finishedAt = now;
    lastAttempt.error = error.message;
  }

  event.status = nextStatus;
  event.lastWorker = workerName;
  event.lastError = error.message;
  event.nextAttemptAt = exhausted
    ? null
    : new Date(now.getTime() + computeBackoffMs(event.attemptCount));
  await event.save();
  return event;
}

async function replayEvent(eventId, requestedBy) {
  const event = await eventRepository.findEventById(eventId);
  if (!event) return null;

  event.status = EVENT_STATUS.REPLAYED;
  event.attemptCount = 0;
  event.nextAttemptAt = new Date();
  event.lastError = null;
  event.lastWorker = requestedBy || "manual-replay";
  await event.save();
  return event;
}

module.exports = {
  computeBackoffMs,
  createEvent,
  listEvents,
  claimNextEvent,
  markCompleted,
  markFailed,
  replayEvent,
};
