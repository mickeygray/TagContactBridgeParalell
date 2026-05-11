"use strict";

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { agentStateRepository } = require("../packages/shared-repositories/src");

async function main() {
  const state = await connectMongo(getSharedConfig());
  if (!state.connected) throw new Error("mongo not connected");
  const agents = await agentStateRepository.listAgentStates({});
  console.log(`total agents: ${agents.length}`);
  for (const a of agents.slice(0, 6)) {
    console.log(`  extensionId=${a.extensionId}  name=${a.name}  company=${a.company}`);
  }
  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
