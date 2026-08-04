"use strict";

// Narrow additive promotion for the 2026-08-03 lead-delivery compute patch.
// This intentionally avoids broad index synchronization, index removal, and
// customer-row inspection. Output contains index names only.

const { getSharedConfig } = require("../packages/shared-config/src");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const LeadCadence = require("../packages/shared-models/src/LeadCadence");
const LeadDeliveryEvent = require("../packages/shared-models/src/LeadDeliveryEvent");

const INDEXES = Object.freeze([
  {
    collection: LeadCadence.collection,
    key: { domain: 1, active: 1, createdAt: -1, _id: -1 },
    options: { name: "lead_cadence_active_delivery_cursor" },
  },
  {
    collection: LeadDeliveryEvent.collection,
    key: { provider: 1, receivedAt: 1, _id: 1 },
    options: {
      name: "lead_delivery_event_pending_recovery",
      partialFilterExpression: { status: "pending" },
    },
  },
  {
    collection: LeadDeliveryEvent.collection,
    key: { provider: 1, nextAttemptAt: 1, receivedAt: 1, _id: 1 },
    options: {
      name: "lead_delivery_event_failed_recovery",
      partialFilterExpression: { status: "failed" },
    },
  },
  {
    collection: LeadDeliveryEvent.collection,
    key: { provider: 1, processingLeaseExpiresAt: 1, receivedAt: 1, _id: 1 },
    options: {
      name: "lead_delivery_event_processing_recovery",
      partialFilterExpression: { status: "processing" },
    },
  },
]);

async function main() {
  const config = getSharedConfig();
  await connectMongo(config);
  const promoted = [];
  try {
    for (const definition of INDEXES) {
      await definition.collection.createIndex(definition.key, definition.options);
      promoted.push(definition.options.name);
    }
  } finally {
    await disconnectMongo();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, promoted })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: String(error?.code || error?.name || "index-promotion-failed") })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { INDEXES };
