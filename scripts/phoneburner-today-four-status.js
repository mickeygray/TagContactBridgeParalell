"use strict";

const path = require("path");

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const snapshot = String(process.argv[2] || "").trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}t/.test(snapshot)) throw new Error("snapshot-required");
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { leadDeliveryRepository } = require("../packages/shared-repositories/src");
  await connectMongo(getSharedConfig());
  try {
    const checkpoint = await leadDeliveryRepository.getCheckpointByKey(`phoneburner-today-four-${snapshot}`);
    if (!checkpoint?.preloadKey) throw new Error("checkpoint-not-found");
    const summary = await leadDeliveryRepository.summarizePacketAssignments(checkpoint.preloadKey);
    process.stdout.write(`${JSON.stringify({
      total: Number(summary.total || 0),
      accepted: Number(summary.accepted || 0),
      pending: Number(summary.pending || 0),
      failed: Number(summary.failed || 0),
      countsByAgent: summary.countsByAgent || {},
    })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "status-read-failed" })}\n`);
  process.exitCode = 1;
});
