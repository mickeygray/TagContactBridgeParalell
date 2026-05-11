"use strict";

/**
 * Registry mapping `HourlyJobEvent.handlerKey` → async handler.
 *
 * Callers that emit retry events (see `emitHourlyJobEvent`) set a
 * handlerKey describing what to do on retry. The sweeper picks jobs
 * off the queue and dispatches them through this registry. Keeping
 * the registry separate means emitters and workers stay decoupled:
 * emitters name a handlerKey; workers register implementations at boot.
 *
 * Behavior:
 *   - `register(handlerKey, fn)` replaces any prior registration.
 *     Double-registration in the same process is fine (idempotent).
 *   - `dispatch(job)` looks up `job.handlerKey`, invokes the fn with
 *     the full job doc, and returns its result.
 *   - Unknown handlerKey → throws a tagged error so the sweeper can
 *     dead-letter immediately (don't burn retry slots on a typo).
 *   - Handlers may throw to request a retry; the sweeper calls
 *     `markHourlyJobFailed` which applies the retry/dead-letter rules.
 *   - Handlers may return any value; truthy results flow through to
 *     `markHourlyJobCompleted` as `job.result`.
 *
 * Registration shape:
 *   register("scoreActivityCall", async (job) => {
 *     const { callLogId, activityId } = job.payload;
 *     return await ringcentralService.scoreCall(callLogId, activityId);
 *   });
 */

const registry = new Map();

class UnknownHandlerError extends Error {
  constructor(handlerKey) {
    super(`No handler registered for "${handlerKey}"`);
    this.name = "UnknownHandlerError";
    this.handlerKey = handlerKey;
    // Tag for the sweeper to distinguish "retry this" from "dead-letter".
    this.deadLetter = true;
  }
}

function register(handlerKey, fn) {
  if (!handlerKey || typeof handlerKey !== "string") {
    throw new TypeError("register(handlerKey, fn): handlerKey must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError(`register("${handlerKey}", fn): fn must be a function`);
  }
  registry.set(handlerKey, fn);
}

function unregister(handlerKey) {
  return registry.delete(handlerKey);
}

function isRegistered(handlerKey) {
  return registry.has(handlerKey);
}

function listRegisteredHandlerKeys() {
  return Array.from(registry.keys()).sort();
}

async function dispatch(job) {
  if (!job || !job.handlerKey) {
    const err = new Error("dispatch: job.handlerKey is required");
    err.deadLetter = true;
    throw err;
  }
  const fn = registry.get(job.handlerKey);
  if (!fn) {
    throw new UnknownHandlerError(job.handlerKey);
  }
  return fn(job);
}

module.exports = {
  UnknownHandlerError,
  dispatch,
  isRegistered,
  listRegisteredHandlerKeys,
  register,
  unregister,
};
