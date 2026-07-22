"use strict";

const path = require("path");
const { resolveProviderEventItem } = require("../packages/shared-services/src/leadDeliveryService");

const APPLY_ACK = "REPLAY-PHONEBURNER-IDENTITY-CONFLICTS";

async function main() {
  const apply = process.argv.includes("--apply");
  const ack = (process.argv.find((arg) => arg.startsWith("--ack=")) || "").slice(6);
  if (apply && ack !== APPLY_ACK) throw new Error("apply-ack-required");
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryEvent } = require("../packages/shared-models/src");
  const { leadDeliveryRepository } = require("../packages/shared-repositories/src");
  const enabled = new Set(Object.entries(require("../config/lead-delivery-agents.json").agents || {})
    .filter(([, policy]) => policy.enabled === true).map(([agentId]) => agentId));
  await connectMongo(getSharedConfig());
  try {
    const events = await LeadDeliveryEvent.find({
      provider: "phoneburner",
      status: "review",
      lastError: "provider-identities-contradict",
    }).select({
      _id: 1,
      version: 1,
      provider: 1,
      providerCallId: 1,
      providerContactId: 1,
      providerExternalLeadId: 1,
    }).lean();
    let eligible = 0;
    let replayed = 0;
    for (const event of events) {
      const candidates = await leadDeliveryRepository.listProviderIdentityCandidates(event, { limit: 100 });
      const resolution = resolveProviderEventItem(candidates, event);
      const agentId = String(resolution.item?.deliveryAgentId || "").trim().toLowerCase();
      if (resolution.status !== "resolved" || !enabled.has(agentId)) continue;
      eligible += 1;
      if (!apply) continue;
      const updated = await leadDeliveryRepository.compareAndSetEvent({
        eventId: String(event._id),
        expectedVersion: event.version,
        expected: { status: "review", lastError: "provider-identities-contradict" },
        set: {
          status: "pending",
          nextAttemptAt: new Date(),
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          lastError: null,
        },
      });
      if (updated) replayed += 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: !apply, reviewed: events.length, eligible, replayed })}\n`);
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "identity-replay-failed" })}\n`);
  process.exitCode = 1;
});

module.exports = { APPLY_ACK };
