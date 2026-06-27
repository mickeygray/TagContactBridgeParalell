"use strict";

// Read-only probe: what active calls exist, what STATE are they in, and what are
// the REAL disposition names on their campaign? Answers "is the call ringing
// (un-dispositionable) vs connected" and "is 'Auto Dispo' even a real name".

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

(async () => {
  const client = createRingcxVoiceClient();
  const active = await client.listActiveCalls().catch((e) => ({ error: e.message }));
  const calls = Array.isArray(active)
    ? active
    : active?.activeCalls || active?.calls || active?.data || active?.result || [];
  console.log(`ACTIVE CALLS: ${Array.isArray(calls) ? calls.length : "?"}`);
  console.log(JSON.stringify(active, null, 1).slice(0, 3500));

  const seenCampaigns = new Set();
  for (const call of Array.isArray(calls) ? calls : []) {
    console.log("\n— CALL —", JSON.stringify(pick(call, [
      "uii", "callState", "state", "status", "agentState", "callType", "direction",
      "campaignId", "campaignName", "dialGroupId", "dgId", "ani", "dnis",
    ])));
    const callUii = call.uii || call.UII;
    async function stillActive(uii) {
      const a = await client.listActiveCalls().catch(() => []);
      const list = Array.isArray(a) ? a : a?.activeCalls || a?.calls || a?.data || [];
      return (Array.isArray(list) ? list : []).some((c) => (c.uii || c.UII) === uii);
    }
    if (process.argv.includes("--try-hangup") && callUii) {
      console.log(`  → TRYING hangupCall(${callUii}) on ACTIVE call …`);
      const res = await client.hangupCall(callUii).catch((e) => ({ error: e.message, status: e.status }));
      console.log("  → hangup RESULT:", JSON.stringify(res));
      await new Promise((r) => setTimeout(r, 1200));
      console.log("  → call still active after hangup?", await stillActive(callUii), "(false = the call DROPPED ✓)");
    }
    if (process.argv.includes("--try-dispose") && callUii) {
      const name = process.argv[process.argv.indexOf("--try-dispose") + 1] || "Auto Dispo";
      console.log(`  → TRYING dispositionCall(${callUii}, "${name}") …`);
      const res = await client.dispositionCall(callUii, { disposition: name, callback: false }).catch((e) => ({ error: e.message, status: e.status }));
      console.log("  → dispose RESULT:", JSON.stringify(res), "(false = rejected)");
      await new Promise((r) => setTimeout(r, 1200));
      console.log("  → call still active after dispose?", await stillActive(callUii), "(false = the call DROPPED ✓)");
    }
    const campaignId = call.campaignId || call.campaign?.campaignId;
    const dialGroupId = call.dialGroupId || call.dgId || call.dialGroup?.dialGroupId;
    if (campaignId && !seenCampaigns.has(campaignId)) {
      seenCampaigns.add(campaignId);
      const disps = await client
        .listCampaignDispositions(campaignId, dialGroupId || undefined)
        .catch((e) => ({ error: e.message }));
      const rows = Array.isArray(disps) ? disps : disps?.dispositions || disps?.data || [];
      console.log(`  CAMPAIGN ${campaignId} DISPOSITIONS (${Array.isArray(rows) ? rows.length : "?"}):`);
      for (const r of Array.isArray(rows) ? rows : []) {
        console.log("   •", JSON.stringify(pick(r, ["disposition", "dispositionId", "isDefault", "isDisabled", "xfer", "hangupOnDisposition", "timeout"])));
      }
    }
  }

  // Also list dispositions for the env default campaign as a fallback reference.
  const envCampaign = process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID;
  const envDg = process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID;
  if (envCampaign && !seenCampaigns.has(envCampaign)) {
    console.log(`\n=== env default campaign ${envCampaign} dispositions ===`);
    const disps = await client.listCampaignDispositions(envCampaign, envDg || undefined).catch((e) => ({ error: e.message }));
    const rows = Array.isArray(disps) ? disps : disps?.dispositions || disps?.data || [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (["Auto Dispo", "VM DROP"].includes(r.disposition)) {
        console.log(`   • FULL "${r.disposition}":`, JSON.stringify(r));
      } else {
        console.log("   •", JSON.stringify(pick(r, ["disposition", "dispositionId", "xfer"])));
      }
    }
  }
})().catch((e) => {
  console.error("PROBE FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
