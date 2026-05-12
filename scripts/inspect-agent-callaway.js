"use strict";

// One-off: dump every AgentState that has any CX wiring (cxAgentId or
// cxProfileId set), and dump the underlying RingCentral CX agent
// profile fields we mirror, so we can compare Anthony Calloway vs
// everyone else.
//
// Usage:
//   node scripts/inspect-agent-callaway.js

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const AgentState = require("../packages/shared-models/src/AgentState");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: ${mongoose.connection.name}`);

  // Look for Anthony Calloway by name.
  const anthonyMatch = await AgentState.find({
    name: { $regex: /(anthony|calloway|callaway)/i },
  }).lean();
  console.log(`\n=== Anthony Calloway matches: ${anthonyMatch.length} ===`);
  for (const doc of anthonyMatch) {
    console.log(JSON.stringify(doc, null, 2));
  }

  // List all CX-enabled agents (anything with cxAgentId set OR
  // cxRouting.enabled true) so we can compare shapes.
  const cxAgents = await AgentState.find({
    $or: [
      { cxAgentId: { $ne: null, $exists: true } },
      { "cxRouting.enabled": true },
    ],
  })
    .sort({ name: 1 })
    .lean();

  console.log(`\n=== CX-wired agents: ${cxAgents.length} ===`);
  for (const a of cxAgents) {
    console.log(
      `\nname=${a.name} ext=${a.extensionId} cxAgentId=${a.cxAgentId} cxProfileId=${a.cxProfileId} company=${a.company}` +
        `\n  cxRouting.enabled=${a.cxRouting?.enabled} desiredAvailability=${a.cxRouting?.desiredAvailability}` +
        `\n  reason=${a.cxRouting?.reason} lastSource=${a.cxRouting?.lastSource} pauseType=${a.cxRouting?.pauseType}` +
        `\n  activityState=${a.activityState} status=${a.status} activePlatform=${a.activePlatform}` +
        `\n  exTelephonyStatus=${a.exTelephonyStatus} exPresenceStatus=${a.exPresenceStatus}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
