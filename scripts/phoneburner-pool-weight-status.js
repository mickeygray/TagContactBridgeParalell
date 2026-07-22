"use strict";

const path = require("path");

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryAgent, LeadDeliveryItem } = require("../packages/shared-models/src");
  const configuration = require("../config/lead-delivery-agents.json");
  const enabled = Object.entries(configuration.agents || {})
    .filter(([, policy]) => policy.enabled === true)
    .map(([agentId, policy]) => ({ agentId, agent: policy.displayName }));
  const enabledIds = enabled.map((row) => row.agentId);
  await connectMongo(getSharedConfig());
  try {
    const pools = await LeadDeliveryItem.aggregate([
      { $match: { activeAttempt: true } },
      { $group: { _id: { pool: "$sourcePool", state: "$state" }, count: { $sum: 1 } } },
    ]);
    const freshAssignments = await LeadDeliveryItem.aggregate([
      { $match: { sourcePool: "new_today", deliveryAgentId: { $in: enabledIds } } },
      { $group: { _id: "$deliveryAgentId", count: { $sum: 1 } } },
    ]);
    const assignmentMap = new Map(freshAssignments.map((row) => [String(row._id), Number(row.count)]));
    const agents = [];
    for (const configured of enabled) {
      const row = await LeadDeliveryAgent.findOne({ agentId: configured.agentId }).select({
        freshReservedThisHour: 1,
        pendingFreshCount: 1,
        lastFreshReservedAt: 1,
        fairnessHourKey: 1,
      }).lean();
      agents.push({
        agent: configured.agent,
        freshAssignedTotal: assignmentMap.get(configured.agentId) || 0,
        freshReservedThisHour: Number(row?.freshReservedThisHour || 0),
        pendingFreshCount: Number(row?.pendingFreshCount || 0),
        lastFreshReservedAt: row?.lastFreshReservedAt || null,
        fairnessHourKey: row?.fairnessHourKey || null,
      });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      pools: pools.map((row) => ({
        pool: String(row._id?.pool || "none"),
        state: String(row._id?.state || "unknown"),
        count: Number(row.count || 0),
      })).sort((a, b) => a.pool.localeCompare(b.pool) || a.state.localeCompare(b.state)),
      agents,
    })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "pool-weight-status-failed" })}\n`);
  process.exitCode = 1;
});
