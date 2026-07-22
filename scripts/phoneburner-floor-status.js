"use strict";

const path = require("path");

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { leadDeliveryRepository } = require("../packages/shared-repositories/src");
  const { LeadDeliveryEvent } = require("../packages/shared-models/src");
  const { reconstructAgentProjection } = require("../packages/shared-services/src/leadDeliveryService");
  const configuration = require("../config/lead-delivery-agents.json");
  const enabled = Object.entries(configuration.agents || {})
    .filter(([, policy]) => policy.enabled === true)
    .map(([agentId, policy]) => ({ agentId, displayName: policy.displayName }));
  await connectMongo(getSharedConfig());
  try {
    const rows = [];
    for (const configured of enabled) {
      const agent = await leadDeliveryRepository.getAgentById(configured.agentId);
      const items = await leadDeliveryRepository.listAgentProjectionItems(configured.agentId);
      const projection = reconstructAgentProjection(items, { agentId: configured.agentId });
      rows.push({
        agent: configured.displayName,
        shiftEnabled: agent?.shiftEnabled === true,
        estimatedOutstanding: Number(agent?.estimatedOutstanding || 0),
        projectedOutstanding: Number(projection.estimatedOutstanding || 0),
        projectionReliable: projection.reliable === true,
        openRefillRequest: agent?.openRefillRequest === true,
        providerAcceptedCount: Number(agent?.providerAcceptedCount || 0),
        providerCompletedCount: Number(agent?.providerCompletedCount || 0),
        lastProviderEvidenceAt: agent?.lastProviderEvidenceAt || null,
      });
    }
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const events = await LeadDeliveryEvent.aggregate([
      { $match: { provider: "phoneburner", receivedAt: { $gte: since } } },
      { $group: { _id: { eventType: "$eventType", status: "$status" }, count: { $sum: 1 } } },
      { $sort: { "_id.eventType": 1, "_id.status": 1 } },
    ]);
    const eventEvidence = await LeadDeliveryEvent.aggregate([
      { $match: { provider: "phoneburner", receivedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            hasCallId: { $gt: [{ $strLenCP: { $ifNull: ["$providerCallId", ""] } }, 0] },
            hasContactId: { $gt: [{ $strLenCP: { $ifNull: ["$providerContactId", ""] } }, 0] },
            hasExternalId: { $gt: [{ $strLenCP: { $ifNull: ["$providerExternalLeadId", ""] } }, 0] },
            resolved: { $gt: [{ $strLenCP: { $ifNull: ["$resolvedItemId", ""] } }, 0] },
            lastError: { $ifNull: ["$lastError", "none"] },
          },
          count: { $sum: 1 },
        },
      },
    ]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 20,
      lowWater: 5,
      agents: rows,
      recentEvents: events.map((event) => ({
        eventType: String(event._id?.eventType || "unknown"),
        status: String(event._id?.status || "unknown"),
        count: Number(event.count || 0),
      })),
      recentEventEvidence: eventEvidence.map((event) => ({
        hasCallId: event._id?.hasCallId === true,
        hasContactId: event._id?.hasContactId === true,
        hasExternalId: event._id?.hasExternalId === true,
        resolved: event._id?.resolved === true,
        reason: String(event._id?.lastError || "none"),
        count: Number(event.count || 0),
      })),
    })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "floor-status-read-failed" })}\n`);
  process.exitCode = 1;
});
