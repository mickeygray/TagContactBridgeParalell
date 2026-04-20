"use strict";

const EVENT_TYPES = Object.freeze({
  INBOUND_DEMO_RECEIVED: "inbound.demo.received",
  OUTBOUND_DEMO_REQUESTED: "outbound.demo.requested",
  RING_DEMO_RECEIVED: "ring.demo.received",
});

const EVENT_KINDS = Object.freeze({
  inbound: {
    eventType: EVENT_TYPES.INBOUND_DEMO_RECEIVED,
    aggregateType: "lead",
    aggregateIdField: "leadId",
    defaultAggregateId: "demo-lead",
    dedupePrefix: "lead",
  },
  outbound: {
    eventType: EVENT_TYPES.OUTBOUND_DEMO_REQUESTED,
    aggregateType: "delivery",
    aggregateIdField: "messageId",
    defaultAggregateId: "demo-message",
    dedupePrefix: "delivery",
  },
  ring: {
    eventType: EVENT_TYPES.RING_DEMO_RECEIVED,
    aggregateType: "call",
    aggregateIdField: "callId",
    defaultAggregateId: "demo-call",
    dedupePrefix: "call",
  },
});

module.exports = {
  EVENT_KINDS,
  EVENT_TYPES,
};
