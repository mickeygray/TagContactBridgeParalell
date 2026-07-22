"use strict";

const path = require("path");

async function allFolderContactIds(client, folderId) {
  const ids = [];
  for (let page = 1; ; page += 1) {
    const result = await client.listFolderContacts(folderId, { page, pageSize: 100 });
    if (!result.ok) throw new Error("folder-read-failed");
    for (const contact of result.contacts) ids.push(String(contact.contactId));
    if (page >= result.totalPages) return ids;
  }
}

async function folderTotal(client, policy) {
  let total = 0;
  for (const folderId of [policy.distributionFolderId, policy.receivingFolderId]) {
    const result = await client.getFolderCount(folderId);
    if (!result.ok) throw new Error("folder-count-failed");
    total += Number(result.count || 0);
  }
  return total;
}

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
  const sources = ["bruce_allen", "sean_lucas"];
  const destinations = ["brad_hansen", "phil_olson"];
  await connectMongo(getSharedConfig());
  try {
    const candidates = [];
    for (const sourceAgentId of sources) {
      const policy = configuration.agents[sourceAgentId];
      const ids = await allFolderContactIds(client, policy.distributionFolderId);
      const items = await LeadDeliveryItem.find({
        provider: "phoneburner",
        providerContactId: { $in: ids },
        deliveryAgentId: sourceAgentId,
        state: "provider_accepted",
        activeAttempt: true,
      }).sort({ receivedAt: -1, _id: 1 }).lean();
      for (const item of items) candidates.push({ item, sourceAgentId, sourceFolderId: policy.distributionFolderId });
    }
    candidates.sort((left, right) => new Date(right.item.receivedAt) - new Date(left.item.receivedAt));
    const totals = Object.fromEntries(await Promise.all(destinations.map(async (agentId) => [
      agentId,
      await folderTotal(client, configuration.agents[agentId]),
    ])));
    const moved = Object.fromEntries(destinations.map((agentId) => [agentId, 0]));
    let failed = 0;
    for (const candidate of candidates) {
      if (destinations.every((agentId) => totals[agentId] >= 10)) break;
      const destinationAgentId = [...destinations].sort((a, b) => totals[a] - totals[b] || a.localeCompare(b))[0];
      if (totals[destinationAgentId] >= 10) continue;
      const contactId = String(candidate.item.providerContactId || "");
      const movedContact = await client.moveContact(contactId, configuration.agents[destinationAgentId].distributionFolderId);
      if (!movedContact.ok) { failed += 1; continue; }
      const updated = await LeadDeliveryItem.findOneAndUpdate({
        _id: candidate.item._id,
        version: candidate.item.version,
        deliveryAgentId: candidate.sourceAgentId,
        providerContactId: contactId,
        state: "provider_accepted",
      }, {
        $set: { deliveryAgentId: destinationAgentId },
        $inc: { version: 1 },
      }, { new: true, runValidators: true }).lean();
      if (!updated) {
        await client.moveContact(contactId, candidate.sourceFolderId);
        failed += 1;
        continue;
      }
      totals[destinationAgentId] += 1;
      moved[destinationAgentId] += 1;
    }
    for (const agentId of [...sources, ...destinations]) {
      const exact = await LeadDeliveryItem.countDocuments({
        deliveryAgentId: agentId,
        activeAttempt: true,
        state: { $in: ["packetized", "provider_accepted", "in_call"] },
      });
      await LeadDeliveryAgent.updateOne({ agentId }, {
        $set: { estimatedOutstanding: exact },
        $inc: { version: 1 },
      }, { runValidators: true });
    }
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, selected: candidates.length, moved, failed, destinationTotals: totals })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "fresh-redistribution-failed" })}\n`);
  process.exitCode = 1;
});
