"use strict";

const { createEvent } = require("../../event-core/src");
const { EVENT_KINDS } = require("../../shared-contracts/src");
const { validateDemoEventPayload } = require("../../shared-validation/src");

async function publishDemoEvent(kind, serviceName, payload) {
  const definition = EVENT_KINDS[kind];
  if (!definition) {
    throw new Error(`Unknown demo event kind: ${kind}`);
  }

  validateDemoEventPayload(kind, payload);

  const aggregateId = String(
    payload?.[definition.aggregateIdField] || definition.defaultAggregateId,
  );

  return createEvent({
    eventType: definition.eventType,
    sourceService: serviceName,
    aggregateType: definition.aggregateType,
    aggregateId,
    dedupeKey:
      payload?.dedupeKey ||
      `${definition.dedupePrefix}:${aggregateId}:${payload?.source || "default"}`,
    payload: payload || {},
  });
}

module.exports = {
  DEMO_EVENT_DEFINITIONS: EVENT_KINDS,
  publishDemoEvent,
};
