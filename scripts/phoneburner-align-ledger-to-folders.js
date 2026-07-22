"use strict";

const path = require("path");

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryAgent, LeadDeliveryItem } = require("../packages/shared-models/src");
  const { createPhoneBurnerClient, createPhoneBurnerEnvironmentCredentialStore } = require("../packages/shared-integrations/src");
  const configuration = require("../config/lead-delivery-agents.json");
  const client = createPhoneBurnerClient({
    credentialStore: createPhoneBurnerEnvironmentCredentialStore(),
    refreshOnUnauthorized: false,
  });
  await connectMongo(getSharedConfig());
  try {
    const summary = {};
    for (const [agentId, policy] of Object.entries(configuration.agents || {})) {
      if (policy.enabled !== true) continue;
      const liveContactIds = new Set();
      for (const folderId of [policy.distributionFolderId, policy.receivingFolderId]) {
        let page = 1;
        while (true) {
          const result = await client.listFolderContacts(folderId, { page, pageSize: 100 });
          if (!result.ok) throw new Error("folder-read-failed");
          for (const contact of result.contacts) liveContactIds.add(String(contact.contactId));
          if (page >= result.totalPages) break;
          page += 1;
        }
      }
      const outstanding = await LeadDeliveryItem.find({
        deliveryAgentId: agentId,
        activeAttempt: true,
        state: { $in: ["provider_accepted", "in_call"] },
      }).select({ _id: 1, providerContactId: 1 }).lean();
      const staleIds = outstanding
        .filter((item) => !liveContactIds.has(String(item.providerContactId || "")))
        .map((item) => item._id);
      if (staleIds.length) {
        await LeadDeliveryItem.updateMany({ _id: { $in: staleIds } }, {
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
          },
          $inc: { version: 1 },
        }, { runValidators: true });
      }
      const exactOutstanding = await LeadDeliveryItem.countDocuments({
        deliveryAgentId: agentId,
        activeAttempt: true,
        state: { $in: ["packetized", "provider_accepted", "in_call"] },
      });
      await LeadDeliveryAgent.updateOne({ agentId }, {
        $set: { estimatedOutstanding: exactOutstanding },
        $inc: { version: 1 },
      }, { runValidators: true });
      summary[agentId] = { physical: liveContactIds.size, releasedStale: staleIds.length, ledger: exactOutstanding };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, agents: summary })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "folder-ledger-alignment-failed" })}\n`);
  process.exitCode = 1;
});
