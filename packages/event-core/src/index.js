"use strict";

const { EVENT_STATUS } = require("./constants");
const EventRecord = require("./models/EventRecord");
const {
  connectMongo,
  disconnectMongo,
  getMongoState,
  resolveMongoConnectionOptions,
} = require("./services/mongo");
const {
  computeBackoffMs,
  createEvent,
  listEvents,
  claimNextEvent,
  markCompleted,
  markFailed,
  replayEvent,
} = require("./services/eventService");
const { processNextEvent } = require("./services/workerService");

module.exports = {
  EVENT_STATUS,
  EventRecord,
  claimNextEvent,
  computeBackoffMs,
  connectMongo,
  createEvent,
  disconnectMongo,
  getMongoState,
  resolveMongoConnectionOptions,
  listEvents,
  markCompleted,
  markFailed,
  processNextEvent,
  replayEvent,
};
