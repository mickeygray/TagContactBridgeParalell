"use strict";

const path = require("path");

async function allContacts(client, folderId) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const result = await client.listFolderContacts(folderId, { page, pageSize: 100 });
    if (!result.ok) throw new Error("folder-read-failed");
    rows.push(...result.contacts);
    if (page >= result.totalPages) return rows;
  }
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryItem } = require("../packages/shared-models/src");
  const { createPhoneBurnerClient, createPhoneBurnerEnvironmentCredentialStore } = require("../packages/shared-integrations/src");
  const configuration = require("../config/lead-delivery-agents.json");
  const client = createPhoneBurnerClient({
    credentialStore: createPhoneBurnerEnvironmentCredentialStore(),
    refreshOnUnauthorized: false,
  });
  const agents = ["brad_hansen", "chris_bolt"];
  await connectMongo(getSharedConfig());
  try {
    const summary = {};
    for (const agentId of agents) {
      const policy = configuration.agents[agentId];
      const contacts = await allContacts(client, policy.providerConfig?.distributionFolderId || policy.distributionFolderId);
      const excess = contacts.slice(20).reverse();
      let returned = 0;
      for (const contact of excess) {
        const contactId = String(contact.contactId || "").trim();
        if (!contactId) continue;
        const item = await LeadDeliveryItem.findOne({
          providerContactId: contactId,
          deliveryAgentId: agentId,
          activeAttempt: true,
        }).lean();
        const deleted = await client.deleteContact(contactId);
        if (deleted?.ok !== true && Number(deleted?.httpStatus) !== 404) continue;
        if (item) {
          await LeadDeliveryItem.findOneAndUpdate({
            _id: item._id,
            version: item.version,
            providerContactId: contactId,
          }, {
            $set: {
              state: "eligible",
              activeAttempt: true,
              deliveryAgentId: null,
              packetId: null,
              provider: null,
              providerContactId: null,
              providerExternalLeadId: null,
              providerAcceptedAt: null,
              providerCompletedAt: null,
              providerCallId: null,
              providerPostState: null,
              providerPostLeaseId: null,
              providerPostLeaseExpiresAt: null,
              reservedAgentId: null,
              reservationReason: "pool-trim-returned-to-queue",
            },
            $inc: { version: 1 },
          }, { runValidators: true });
        }
        returned += 1;
      }
      summary[agentId] = { before: contacts.length, kept: Math.min(20, contacts.length), returned };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: String(error?.message || "pool-trim-failed").slice(0, 80) })}\n`);
  process.exitCode = 1;
});
