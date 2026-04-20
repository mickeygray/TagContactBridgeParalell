"use strict";

const { claimNextEvent, markCompleted, markFailed } = require("./eventService");

async function processNextEvent({ workerName, handlers, maxAttempts = 3 }) {
  const eventTypes = Object.keys(handlers || {});
  const event = await claimNextEvent(workerName, { eventTypes });
  if (!event) {
    return { claimed: false };
  }

  const handler = handlers[event.eventType];
  if (!handler) {
    await markFailed(
      event._id,
      workerName,
      new Error(`No handler registered for ${event.eventType}`),
      maxAttempts,
    );
    return { claimed: true, handled: false, eventId: String(event._id) };
  }

  try {
    await handler(event);
    await markCompleted(event._id, workerName);
    return { claimed: true, handled: true, eventId: String(event._id) };
  } catch (error) {
    await markFailed(event._id, workerName, error, maxAttempts);
    return {
      claimed: true,
      handled: false,
      eventId: String(event._id),
      error: error.message,
    };
  }
}

module.exports = {
  processNextEvent,
};
