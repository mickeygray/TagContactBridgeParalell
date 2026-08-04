"use strict";

// One-off cutover companion to phoneburner-drain-working-folders.js.
// Once the physical folders are empty, this releases only unfinished provider
// delivery attempts so the new runtime starts from a truthful zero projection.

const path = require("path");

// This box cannot resolve SRV records, so the mongodb+srv:// lookup fails as
// ECONNREFUSED and the script dies before it reaches Mongo. Same opt-in
// override scripts/report.js carries; a no-op unless DNS_SERVERS is set.
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch { /* an unusable override must not block the reset */ }
}

const APPLY_ACK = "RESET-PHONEBURNER-DELIVERY-LEDGER";
const RESET_STATES = Object.freeze(["packetized", "provider_accepted", "in_call", "delivery_failed"]);

function parseArgs(argv) {
  const options = { apply: false, ack: null };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--ack=")) options.ack = arg.slice(6);
    else throw new Error("unknown-option");
  }
  if (options.apply && options.ack !== APPLY_ACK) throw new Error("apply-ack-required");
  return options;
}

async function run(options) {
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryAgent, LeadDeliveryItem } = require("../packages/shared-models/src");
  const configuration = require("../config/lead-delivery-agents.json");
  const agentIds = Object.entries(configuration.agents || {})
    .filter(([, agent]) => agent.enabled === true)
    .map(([agentId]) => String(agentId || "").trim().toLowerCase());
  if (!agentIds.length) throw new Error("no-enabled-agents");

  await connectMongo(getSharedConfig());
  try {
    const itemFilter = {
      deliveryAgentId: { $in: agentIds },
      activeAttempt: true,
      state: { $in: RESET_STATES },
    };
    const before = await LeadDeliveryItem.aggregate([
      { $match: itemFilter },
      { $group: { _id: "$state", count: { $sum: 1 } } },
    ]);
    const countsByState = Object.fromEntries(before.map((row) => [String(row._id), Number(row.count)]));
    const total = before.reduce((sum, row) => sum + Number(row.count), 0);
    if (!options.apply) return { ok: true, dryRun: true, total, countsByState };

    const items = await LeadDeliveryItem.updateMany(itemFilter, {
      $set: {
        state: "eligible",
        activeAttempt: true,
        reservedAgentId: null,
        speedOverrideAgentId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        reservationReason: null,
        packetId: null,
        deliveryAgentId: null,
        provider: null,
        providerContactId: null,
        providerExternalLeadId: null,
        providerAcceptedAt: null,
        providerCompletedAt: null,
        providerCallId: null,
        providerPostState: null,
        providerPostLeaseId: null,
        providerPostLeaseExpiresAt: null,
        attemptedAt: null,
      },
      $inc: { version: 1 },
    }, { runValidators: true });
    const agents = await LeadDeliveryAgent.updateMany({ agentId: { $in: agentIds } }, {
      $set: {
        estimatedOutstanding: 0,
        openRefillRequest: false,
        refillRequestId: null,
        refillLeaseExpiresAt: null,
        pendingFreshCount: 0,
      },
      $inc: { version: 1 },
    }, { runValidators: true });
    const remaining = await LeadDeliveryItem.countDocuments(itemFilter);
    return {
      ok: remaining === 0,
      dryRun: false,
      matchedItems: Number(items.matchedCount || 0),
      resetItems: Number(items.modifiedCount || 0),
      resetAgents: Number(agents.modifiedCount || 0),
      remaining,
    };
  } finally {
    await disconnectMongo();
  }
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  try {
    const result = await run(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: String(error?.message || "ledger-reset-failed").slice(0, 80) })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { APPLY_ACK, RESET_STATES, parseArgs, run };
