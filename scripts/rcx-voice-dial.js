"use strict";

// Progressive (PREVIEW + progressiveEnabled) dial smoke test.
//
// In progressive mode the SYSTEM dials, not the agent. Workflow:
//   1. Bootstrap has set up: dial group (PREVIEW + progressiveEnabled
//      + 5s delay), campaign, agent record (ballen, allowOutbound)
//   2. Ballen has logged into the agent dashboard, picked the
//      Integrated Softphone, picked the dial group, set state AVAILABLE
//   3. This script loads ONE lead into the campaign
//   4. Within the progressive delay (~5s) the system fetches the lead,
//      shows ballen the preview, then auto-dials her softphone
//   5. Ballen takes the call, dispositions in the dashboard
//   6. Script (optionally) cancels the test lead so the campaign
//      doesn't try to re-dial it later
//
// Usage:
//   node scripts/rcx-voice-dial.js --to +18185551212
//   node scripts/rcx-voice-dial.js --to +18185551212 --manual
//       (uses placeManualCall instead — bypasses the campaign entirely;
//        useful for testing the auth/permission chain without needing
//        ballen to be logged in to a dial group)
//   node scripts/rcx-voice-dial.js --to +18185551212 --keep-lead
//   node scripts/rcx-voice-dial.js --to +18185551212 --dry

const path = require("path");
const readline = require("readline");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) { return argv.includes(name); }
function logHeader(s) { console.log(`\n══ ${s}`); }
function logKv(k, v) { console.log(`  ${String(k).padEnd(28)} ${v}`); }
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}

async function main() {
  const argv = process.argv.slice(2);
  const to = readFlag(argv, "--to");
  const dry = hasFlag(argv, "--dry");
  const manual = hasFlag(argv, "--manual");
  const keepLead = hasFlag(argv, "--keep-lead");
  const callerId = readFlag(argv, "--caller-id")
    || (process.env.RING_CENTRAL_RINGOUT_CALLER || "").replace(/\D/g, "").slice(-10);
  const campaignId = readFlag(argv, "--campaign-id") || process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID || "";
  const dialGroupId = readFlag(argv, "--dial-group-id") || process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID || "";
  const agentEmail = readFlag(argv, "--agent-email")
    || process.env.RINGCX_VOICE_AGENT_EMAIL
    || process.env.RINGCX_VOICE_RC_USER_EMAIL;

  if (!to) {
    console.error("usage: node scripts/rcx-voice-dial.js --to <phone>");
    console.error("");
    console.error("modes:");
    console.error("  (default)  load a lead into the campaign — system auto-dials when agent AVAILABLE");
    console.error("  --manual   bypass campaign, use placeManualCall directly");
    process.exit(1);
  }
  const destination = normalizePhone(to);
  if (!destination) {
    console.error(`could not normalize phone: ${to}`);
    process.exit(1);
  }

  logHeader(`rcx-voice-dial — ${manual ? "MANUAL" : "PROGRESSIVE"} mode`);
  logKv("destination", destination);
  logKv("agent email", agentEmail || "(not set)");
  logKv("dial group id", dialGroupId || "(not set)");
  logKv("campaign id", campaignId || "(will be looked up)");
  logKv("caller id", callerId || "(none — campaign default)");
  logKv("dry-run", dry);

  if (!agentEmail) {
    console.error("\n❌ no agent email; set RINGCX_VOICE_AGENT_EMAIL");
    process.exit(1);
  }

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();
  logKv("authed as", who.rcUser?.email);
  logKv("accountId", who.accountId);

  // ── Path A: MANUAL — placeManualCall ─────────────────────────────
  // Use this path when:
  //   - ballen isn't yet attached to the dial group
  //   - or you want to dial outside any campaign
  //   - or you're verifying the auth/permission chain without
  //     needing the dashboard to be open in PROGRESSIVE state
  if (manual) {
    logHeader("MANUAL: place call directly");
    if (dry) {
      logKv("would POST", "/activeCalls/createManualAgentCall");
      logKv("query", `username=${agentEmail}&destination=${destination}&callerId=${callerId || "(none)"}&ringDuration=5`);
      return;
    }
    let uii = null;
    try {
      const r = await client.placeManualCall({
        agentEmail, destination,
        callerId: callerId || undefined,
        ringDuration: 5,
      });
      uii = r?.uii || r?.callId || r?.activeCallId || null;
      logKv("placed", "✅");
      logKv("uii", uii || "(not in response)");
      console.log(`     full response: ${JSON.stringify(r).slice(0, 400)}`);
    } catch (e) {
      console.error(`placeManualCall failed: ${e.message}`);
      if (e?.details?.responseBody) console.error(JSON.stringify(e.details.responseBody, null, 2));
      process.exit(1);
    }
    if (uii) {
      await ask("\n  ENTER when done with call to dispose: ");
      try {
        await client.dispositionCall(uii, { disposition: "COMPLETED", phone: destination, notes: "manual smoke" });
        logKv("disposition", "✅");
      } catch (e) { console.error(`disposition: ${e.message}`); }
      try { await client.hangupCall(uii); } catch {}
    }
    return;
  }

  // ── Path B: PROGRESSIVE — load lead, system dials ────────────────
  let resolvedCampaignId = campaignId;
  if (!resolvedCampaignId) {
    if (!dialGroupId) {
      console.error("\n❌ need --campaign-id or --dial-group-id (or RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID)");
      process.exit(1);
    }
    try {
      const camps = await client.listCampaigns(dialGroupId);
      if (!camps || camps.length === 0) {
        console.error(`\n❌ no campaigns under dial group ${dialGroupId}. Run rcx-voice-bootstrap.js first.`);
        process.exit(1);
      }
      // Prefer the test campaign by name, else first available
      const test = camps.find((c) => /test/i.test(c.campaignName || ""));
      resolvedCampaignId = (test || camps[0]).campaignId;
      logKv("resolved campaign", `${resolvedCampaignId} (${(test || camps[0]).campaignName})`);
    } catch (e) {
      console.error(`listCampaigns failed: ${e.message}`);
      process.exit(1);
    }
  }

  // 1. Load the lead
  logHeader("Load lead into campaign");
  const externId = `smoke-${Date.now()}`;
  const loadPayload = {
    description: `progressive smoke ${externId}`,
    dialPriority: "IMMEDIATE",
    duplicateHandling: "REMOVE_FROM_LIST",
    listState: "ACTIVE",
    timeZoneOption: "NPA_NXX",
    phoneNumbersI18nEnabled: false,
    internationalNumberFormat: false,
    uploadLeads: [{
      externId,
      leadPhone: destination,
      firstName: "Smoke",
      lastName: "Test",
    }],
  };
  if (dry) {
    logKv("would POST", `/campaigns/${resolvedCampaignId}/leadLoader/direct`);
    logKv("externId", externId);
  } else {
    try {
      const r = await client.loadLeads(resolvedCampaignId, loadPayload);
      logKv("loadLeads", JSON.stringify(r).slice(0, 200));
      logKv("externId", externId);
    } catch (e) {
      console.error(`loadLeads failed: ${e.message}`);
      if (e?.details?.responseBody) console.error(JSON.stringify(e.details.responseBody, null, 2));
      process.exit(1);
    }
  }

  if (dry) return;

  // 2. Wait for the system to dial → agent talks → agent dispositions
  logHeader("System will auto-dial");
  console.log("  ✅ Lead loaded. The dial group is set to PREVIEW + progressiveEnabled");
  console.log("     with a ~5-second preview window.");
  console.log("");
  console.log("  Make sure the agent is set up:");
  console.log("    1. Open https://ringcx.ringcentral.com/voice/agent/");
  console.log(`    2. Sign in as ${agentEmail}`);
  console.log("    3. Pick 'Integrated Softphone' as the device");
  console.log("    4. Pick the dial group 'Parallel Outbound'");
  console.log("    5. Set state to AVAILABLE");
  console.log("");
  console.log("  Within ~5 seconds of going AVAILABLE, the agent's softphone will ring.");
  console.log("  After the call, dispose in the dashboard. The lead status flips automatically.");
  console.log("");
  await ask("  ENTER when the test call is complete to clean up the test lead: ");

  // 3. Cleanup — cancel the test lead so the campaign doesn't re-dial it
  if (!keepLead) {
    logHeader("Cancel test lead");
    try {
      const r = await client.leadAction("CANCEL_LEADS", {
        campaignId: resolvedCampaignId,
        externIds: [externId],
      });
      logKv("cancel", JSON.stringify(r).slice(0, 200));
    } catch (e) {
      console.error(`cancel failed (non-fatal): ${e.message}`);
      if (e?.details?.responseBody) console.error(JSON.stringify(e.details.responseBody));
    }
  } else {
    logKv("keep-lead", "skipped cancel");
  }
  logHeader("Done");
}

main().catch((e) => {
  console.error("\nfatal:", e.message);
  if (e?.details) console.error(JSON.stringify(e.details, null, 2));
  process.exit(1);
});
