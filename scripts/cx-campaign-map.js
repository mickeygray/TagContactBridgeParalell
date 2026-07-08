"use strict";

require("dotenv").config();

// CAMPAIGN MAP PROBE (Mickey's order, 2026-07-08): read-only sweep of every RingCX dial
// group + campaign so the per-agent lane maps (CX_FIRST_TOUCH_QUEUE_MAP / CX_APPT_QUEUE_MAP)
// get built from REAL ids, not guesses. Flags first-touch / first-contact / appointment
// flavored names and prints draft map JSON.
//
//   node scripts/cx-campaign-map.js

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

const LANE_HINTS = [
  { lane: "firstTouch", pattern: /first.?(touch|contact)|new.?lead|\bnew\b/i },
  { lane: "appointment", pattern: /app?oint|appt/i },
];

function rows(value) {
  return Array.isArray(value) ? value : value?.records || value?.results || [];
}

async function main() {
  const client = createRingcxVoiceClient();
  const groups = rows(await client.listDialGroups());
  console.log(`dial groups: ${groups.length}\n`);
  const flagged = { firstTouch: [], appointment: [] };
  for (const group of groups) {
    const groupId = group.dialGroupId ?? group.id;
    const groupName = group.dialGroupName || group.name || "(unnamed)";
    let campaigns = [];
    try {
      campaigns = rows(await client.listCampaigns(groupId));
    } catch (error) {
      console.log(`  group ${groupId} "${groupName}" — campaign list failed: ${error.message}`);
      continue;
    }
    console.log(`group ${groupId} "${groupName}" — ${campaigns.length} campaign(s)`);
    for (const campaign of campaigns) {
      const campaignId = campaign.campaignId ?? campaign.id;
      const name = campaign.campaignName || campaign.name || "(unnamed)";
      const active = campaign.isActive ?? campaign.active ?? "?";
      let hint = "";
      for (const { lane, pattern } of LANE_HINTS) {
        if (pattern.test(name)) {
          hint = `  <-- ${lane.toUpperCase()} candidate`;
          flagged[lane].push({ campaignId, name, groupId, groupName });
        }
      }
      console.log(`   campaign ${campaignId} "${name}" active=${active}${hint}`);
    }
  }

  for (const [lane, list] of Object.entries(flagged)) {
    console.log(`\n=== ${lane} candidates (${list.length}) — draft map (bind agent emails by name) ===`);
    const draft = {};
    for (const c of list) draft[`AGENT_EMAIL_FOR<${c.name}>`] = Number(c.campaignId) || c.campaignId;
    console.log(JSON.stringify(draft, null, 2));
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
