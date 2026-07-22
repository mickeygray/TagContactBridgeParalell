"use strict";

const path = require("path");

async function folderIds(client, folderId) {
  const ids = [];
  for (let page = 1; ; page += 1) {
    const result = await client.listFolderContacts(folderId, { page, pageSize: 100 });
    if (!result.ok) throw new Error("folder-read-failed");
    ids.push(...result.contacts.map((row) => String(row.contactId)));
    if (page >= result.totalPages) return ids;
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
  const destinationIds = ["brad_hansen", "phil_olson"];
  const sourceIds = new Set(["bruce_allen", "sean_lucas"]);
  await connectMongo(getSharedConfig());
  try {
    const candidates = [];
    const changedAfter = new Date(Date.now() - 30 * 60_000);
    for (const destinationId of destinationIds) {
      const items = await LeadDeliveryItem.find({
        deliveryAgentId: destinationId,
        providerContactId: { $type: "string", $ne: "" },
        state: "provider_accepted",
        updatedAt: { $gte: changedAfter },
      }).sort({ updatedAt: -1 }).lean();
      for (const item of items) {
        const history = Array.isArray(item.providerAttemptHistory) ? item.providerAttemptHistory : [];
        const sourceId = [...history].reverse().map((row) => String(row.deliveryAgentId || "").trim().toLowerCase())
          .find((agentId) => sourceIds.has(agentId));
        if (sourceId) candidates.push({ item, destinationId, sourceId });
      }
    }
    if (candidates.length === 0) throw new Error("exact-redistribution-set-not-found");
    let restored = 0;
    for (const candidate of candidates) {
      const contactId = String(candidate.item.providerContactId || "");
      const read = await client.getContact(contactId);
      if (!read.ok) continue;
      const currentFolderId = String(read.contact?.folderId || "");
      const destinationPolicy = configuration.agents[candidate.destinationId];
      if (![destinationPolicy.distributionFolderId, destinationPolicy.receivingFolderId].map(String).includes(currentFolderId)) continue;
      const moved = await client.moveContact(contactId, configuration.agents[candidate.sourceId].distributionFolderId);
      if (!moved.ok) throw new Error("reverse-move-failed");
      const updated = await LeadDeliveryItem.findOneAndUpdate({
        _id: candidate.item._id,
        version: candidate.item.version,
        deliveryAgentId: candidate.destinationId,
        providerContactId: contactId,
      }, {
        $set: { deliveryAgentId: candidate.sourceId },
        $inc: { version: 1 },
      }, { new: true, runValidators: true }).lean();
      if (!updated) throw new Error("reverse-ledger-conflict");
      restored += 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, restored })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: String(error?.message || "redistribution-reversal-failed").slice(0, 80) })}\n`);
  process.exitCode = 1;
});
