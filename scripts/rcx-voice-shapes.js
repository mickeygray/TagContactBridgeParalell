"use strict";

// Quick shape probe — dumps the real response shapes for the
// resources we just created so we know the actual field names.
// Also tries a minimal createAgent to capture the 400 message.

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

(async () => {
  const c = createRingcxVoiceClient();
  const out = path.join(__dirname, "..", "out", "rcx-voice");
  fs.mkdirSync(out, { recursive: true });

  console.log("=== /dialGroups ===");
  const dgs = await c.listDialGroups();
  console.log(JSON.stringify(dgs, null, 2));
  fs.writeFileSync(path.join(out, "dialGroups.json"), JSON.stringify(dgs, null, 2));

  console.log("\n=== /agentGroups ===");
  const ags = await c.listAgentGroups();
  console.log(JSON.stringify(ags, null, 2));
  fs.writeFileSync(path.join(out, "agentGroups.json"), JSON.stringify(ags, null, 2));

  // For each agent group, list agents
  for (const g of ags) {
    const agId = g.agentGroupId || g.id;
    console.log(`\n=== /agentGroups/${agId}/agents ===`);
    try {
      const agents = await c.listAgents(agId);
      console.log(JSON.stringify(agents, null, 2));
      fs.writeFileSync(path.join(out, `agents-${agId}.json`), JSON.stringify(agents, null, 2));
    } catch (e) {
      console.log(`ERR: ${e.message}`);
    }
  }

  // Try a minimal createAgent against the most-recent agent group
  // and capture the full error so we know the right shape.
  const newest = ags[ags.length - 1];
  if (newest) {
    const agentGroupId = newest.agentGroupId || newest.id;
    console.log(`\n=== probing createAgent against group ${agentGroupId} ===`);
    const minimalPayloads = [
      // Try v1: minimal
      { username: "ballen@taxadvocategroup.com", isActive: 1 },
      // Try v2: include rcUserId
      { username: "ballen@taxadvocategroup.com", rcUserId: process.env.RINGCX_VOICE_AGENT_RC_USER_ID, isActive: 1 },
      // Try v3: with email + name + rcUserId
      {
        username: "ballen@taxadvocategroup.com",
        email: "ballen@taxadvocategroup.com",
        firstName: "Bryce",
        lastName: "Allen",
        rcUserId: process.env.RINGCX_VOICE_AGENT_RC_USER_ID,
        isActive: 1,
      },
      // Try v4: agentExternId + rcUserId + name
      {
        agentExternId: "ballen@taxadvocategroup.com",
        username: "ballen@taxadvocategroup.com",
        firstName: "Bryce",
        lastName: "Allen",
        email: "ballen@taxadvocategroup.com",
        rcUserId: process.env.RINGCX_VOICE_AGENT_RC_USER_ID,
        isActive: 1,
        initLoginBaseState: "AVAILABLE",
        dialGroupIds: [Number(process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID)],
      },
    ];
    for (const [i, payload] of minimalPayloads.entries()) {
      console.log(`\n--- payload v${i + 1} ---`);
      console.log(JSON.stringify(payload, null, 2));
      try {
        const r = await c.createAgent(payload, agentGroupId);
        console.log(`✅ created: ${JSON.stringify(r).slice(0, 400)}`);
        break;
      } catch (e) {
        console.log(`❌ ${e.message}`);
        if (e?.details?.responseBody) {
          console.log(`   response: ${JSON.stringify(e.details.responseBody).slice(0, 600)}`);
        }
      }
    }
  }

  console.log(`\nartifacts in ${out}`);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
