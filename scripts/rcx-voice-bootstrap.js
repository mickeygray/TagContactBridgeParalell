"use strict";

// One-shot bootstrap for the RingCX Voice outbound dialer.
//
// Creates (idempotently) the four resources we need before we can
// dial:
//   1. Dial Group   — container for campaigns; sets the dialer mode
//   2. Agent Group  — container for agents
//   3. Agent        — linked to your RC user via rcUserId; this is
//                     the identity that placeManualCall targets
//   4. Test Campaign — nested under the dial group; first scratch
//                     campaign for end-to-end smoke testing
//
// After it runs, re-runs `rcx-voice-discover.js --append` so the
// new IDs land in .env automatically.
//
// Usage:
//   node scripts/rcx-voice-bootstrap.js
//   node scripts/rcx-voice-bootstrap.js --dial-mode PREVIEW
//   node scripts/rcx-voice-bootstrap.js --campaign-caller-id 8004719431
//   node scripts/rcx-voice-bootstrap.js --dry            # show plan, don't write
//
// Safe to run multiple times — checks for existing rows by name and
// reuses them rather than creating duplicates.

const path = require("path");
const { spawnSync } = require("child_process");
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

function logHeader(line) { console.log(`\n══ ${line}`); }
function logKv(k, v) { console.log(`  ${String(k).padEnd(28)} ${v}`); }
function logBullet(msg) { console.log(`  • ${msg}`); }

async function findByName(rows, key, target) {
  for (const r of rows || []) {
    // RingCX sometimes returns the field under multiple names. Check
    // the explicit key first, then the common fallbacks. Empty-string
    // / null name fields don't match anything (avoids matching the
    // first row when both rows have null names).
    const candidates = [r[key], r.name, r.label, r.dialGroupName, r.agentGroupName, r.groupName, r.campaignName]
      .map((v) => (v == null ? "" : String(v).trim().toLowerCase()))
      .filter(Boolean);
    if (candidates.includes(String(target || "").trim().toLowerCase())) return r;
  }
  return null;
}

// Dedup an agent across the entire account (not just a single group)
// since RingCX enforces username uniqueness account-wide. Walks every
// agent group and returns { agent, agentGroupId } if found.
async function findExistingAgent(client, username) {
  const target = String(username || "").trim().toLowerCase();
  const groups = await client.listAgentGroups();
  for (const g of groups) {
    const groupId = g.agentGroupId || g.id;
    if (!groupId) continue;
    try {
      const agents = await client.listAgents(groupId);
      const hit = (agents || []).find(
        (a) => String(a.username || a.email || "").trim().toLowerCase() === target,
      );
      if (hit) return { agent: hit, agentGroupId: groupId };
    } catch {}
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  // Dial mode vocabulary (RingCX-specific) — important: RingCX's
  // canonical "progressive with a live agent on the line" is NOT
  // dialMode=POWER (that's voice-broadcast, no agent), but rather
  //   dialMode=PREVIEW + progressiveEnabled=true + progressiveCallDelay=N
  // which gives the agent an N-second preview window then auto-dials.
  // PREVIEW alone (no progressiveEnabled) = agent must click to dial.
  // PREDICTIVE = multi-line system pacing, agent gets connected calls only.
  const dialMode = (readFlag(argv, "--dial-mode") || "PREVIEW").toUpperCase();
  const progressiveEnabled = readFlag(argv, "--progressive") !== "false";
  const progressiveCallDelay = Number(readFlag(argv, "--progressive-delay") || 5);
  const dialGroupName = readFlag(argv, "--dial-group-name") || "Parallel Outbound";
  const agentGroupName = readFlag(argv, "--agent-group-name") || "Parallel Agents";
  const campaignName = readFlag(argv, "--campaign-name") || "Parallel Test Campaign";
  const callerId = readFlag(argv, "--campaign-caller-id") || (process.env.RING_CENTRAL_RINGOUT_CALLER || "").replace(/\D/g, "").slice(-10);
  const availableStateId = Number(
    readFlag(argv, "--available-state-id")
      || process.env.RINGCX_VOICE_AUX_AVAILABLE_STATE_ID
      || 5877,
  );
  // Agent identity — separate from auth identity. Prefer the
  // dedicated agent (ballen) over the admin (mgray) so the created
  // agent record points at the right RC user.
  const agentEmail = readFlag(argv, "--agent-email")
    || process.env.RINGCX_VOICE_AGENT_EMAIL
    || process.env.RINGCX_VOICE_RC_USER_EMAIL
    || "";
  const agentRcUserId = readFlag(argv, "--agent-rc-user-id")
    || process.env.RINGCX_VOICE_AGENT_RC_USER_ID
    || process.env.RINGCX_VOICE_RC_USER_ID
    || "";
  const dry = hasFlag(argv, "--dry");

  logHeader("rcx-voice-bootstrap");
  logKv("dial mode", `${dialMode}${progressiveEnabled ? ` + progressive (${progressiveCallDelay}s preview)` : ""}`);
  logKv("dial group name", dialGroupName);
  logKv("agent group name", agentGroupName);
  logKv("campaign name", campaignName);
  logKv("caller id", callerId || "(not set — campaign create will fail)");
  logKv("agent email", agentEmail || "(not set)");
  logKv("agent rcUserId", agentRcUserId || "(not set)");
  logKv("dry-run", dry);

  if (!callerId) {
    console.error("\n❌ no caller id available. Pass --campaign-caller-id <10-digit> or set RING_CENTRAL_RINGOUT_CALLER in .env");
    process.exit(1);
  }
  if (!agentEmail) {
    console.error("\n❌ no agent email available. Pass --agent-email or set RINGCX_VOICE_RC_USER_EMAIL");
    process.exit(1);
  }

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();
  logHeader("Auth");
  logKv("rcUser", who.rcUser?.email);
  logKv("accountId", who.accountId);
  logKv("mainAccountId", who.mainAccountId);

  // ── 1. Dial group ────────────────────────────────────────────────
  logHeader("1. Dial Group");
  let dialGroups = [];
  try { dialGroups = await client.listDialGroups(); } catch (e) { console.error("listDialGroups failed:", e.message); throw e; }
  let dialGroup = await findByName(dialGroups, "dialGroupName", dialGroupName)
    || await findByName(dialGroups, "name", dialGroupName);
  if (dialGroup) {
    logBullet(`reusing existing dial group: ${dialGroup.dialGroupName || dialGroup.name} (id=${dialGroup.dialGroupId || dialGroup.id})`);
  } else if (dry) {
    logBullet(`would CREATE dial group "${dialGroupName}" (mode ${dialMode})`);
  } else {
    logBullet(`creating dial group "${dialGroupName}"...`);
    // Field shape per RingCX docs — we keep it minimal and let the
    // server fill defaults. `dialMode` controls the dialer behavior.
    dialGroup = await client.createDialGroup({
      dialGroupName,
      dialGroupDesc: `Auto-created by rcx-voice-bootstrap (${dialMode}${progressiveEnabled ? `+progressive ${progressiveCallDelay}s` : ""})`,
      dialMode,
      progressiveEnabled,
      progressiveCallDelay: progressiveEnabled ? progressiveCallDelay : 0,
      isActive: 1,
      minPredictiveAgents: 1,
      maxPorts: 1,
    });
    logBullet(`created: id=${dialGroup.dialGroupId || dialGroup.id}`);
  }
  const dialGroupId = dialGroup?.dialGroupId || dialGroup?.id || null;

  // ── 2. Agent group ───────────────────────────────────────────────
  // First check whether the agent we plan to use already exists
  // somewhere on the account — if it does, we'll reuse the group it
  // lives in instead of spinning up an empty placeholder.
  logHeader("2. Agent Group");
  let agentGroups = [];
  try { agentGroups = await client.listAgentGroups(); } catch (e) { console.error("listAgentGroups failed:", e.message); throw e; }

  let preExistingAgentLookup = null;
  if (!dry) {
    try { preExistingAgentLookup = await findExistingAgent(client, agentEmail); } catch {}
  }

  let agentGroup = null;
  if (preExistingAgentLookup) {
    agentGroup = (agentGroups || []).find(
      (g) => Number(g.agentGroupId || g.id) === Number(preExistingAgentLookup.agentGroupId),
    );
    if (agentGroup) {
      logBullet(`reusing agent group ${agentGroup.agentGroupId || agentGroup.id} (contains existing agent ${agentEmail})`);
    }
  }
  if (!agentGroup) {
    agentGroup = await findByName(agentGroups, "agentGroupName", agentGroupName)
      || await findByName(agentGroups, "name", agentGroupName)
      || await findByName(agentGroups, "groupName", agentGroupName);
  }
  if (agentGroup) {
    if (!preExistingAgentLookup) {
      logBullet(`reusing existing agent group: ${agentGroup.agentGroupName || agentGroup.groupName || agentGroup.name || "(unnamed)"} (id=${agentGroup.agentGroupId || agentGroup.id})`);
    }
  } else if (dry) {
    logBullet(`would CREATE agent group "${agentGroupName}"`);
  } else {
    logBullet(`creating agent group "${agentGroupName}"...`);
    agentGroup = await client.createAgentGroup({
      agentGroupName,
      agentGroupDesc: "Auto-created by scripts/rcx-voice-bootstrap.js",
      isActive: 1,
    });
    logBullet(`created: id=${agentGroup.agentGroupId || agentGroup.id}`);
  }
  const agentGroupId = agentGroup?.agentGroupId || agentGroup?.id || null;

  // ── 3. Agent (linked to RC user) ─────────────────────────────────
  // RingCX enforces username uniqueness ACCOUNT-WIDE, not per-group.
  // We sweep every group looking for an existing agent with this
  // username before deciding to create. If we find one in a different
  // group than the one we just created, we use the existing agent
  // and ignore the empty placeholder group.
  logHeader("3. Agent");
  let existingAgent = null;
  let existingAgentGroupId = null;
  if (!dry) {
    try {
      const found = await findExistingAgent(client, agentEmail);
      if (found) {
        existingAgent = found.agent;
        existingAgentGroupId = found.agentGroupId;
      }
    } catch (e) {
      console.error("findExistingAgent failed:", e.message);
    }
  }
  let agent = existingAgent;
  if (agent) {
    logBullet(`reusing existing agent: ${agent.username || agent.email} (id=${agent.agentId || agent.id}, group=${existingAgentGroupId})`);

    // Patch fields that bootstrap should keep correct:
    //   - firstName/lastName from the resolved RC user (if known)
    //   - allowOutbound: true                  (required for placeManualCall)
    //   - allowManualCalls: true               (mandatory for the manual-dial endpoint)
    //   - dialGroupIds: ensure our dial group is attached
    //   - rcUserId: lock to the resolved value
    const desiredFirst = agent.firstName === "Michael" || !agent.firstName ? (readFlag(argv, "--agent-first-name") || "Bryce") : agent.firstName;
    const desiredLast = agent.lastName === "Gray" || !agent.lastName ? (readFlag(argv, "--agent-last-name") || "Allen") : agent.lastName;
    const dialGroupIds = [...new Set([...(agent.dialGroupIds || []), dialGroupId].filter(Boolean))];
    const patch = {
      firstName: desiredFirst,
      lastName: desiredLast,
      rcUserId: agentRcUserId ? Number(agentRcUserId) : agent.rcUserId,
      allowOutbound: true,
      allowManualCalls: true,
      // allowOffHook controls phone-session binding. Required to be
      // true even for the integrated softphone (WebRTC routes through
      // the off-hook session). Without it: dashboard says "you are
      // not allowed to go off hook" when going AVAILABLE, and
      // createManualAgentCall returns "no offhook session".
      allowOffHook: true,
      isActive: true,
      dialGroupIds,
    };
    const needsPatch =
      agent.firstName !== desiredFirst
      || agent.lastName !== desiredLast
      || agent.allowOutbound !== true
      || agent.allowManualCalls !== true
      || agent.allowOffHook !== true
      || (agentRcUserId && Number(agent.rcUserId) !== Number(agentRcUserId))
      || dialGroupIds.some((id) => !(agent.dialGroupIds || []).includes(id));
    if (needsPatch) {
      if (dry) {
        logBullet(`would PATCH agent: ${JSON.stringify(patch)}`);
      } else {
        logBullet(`patching agent: name → ${desiredFirst} ${desiredLast}, allowOutbound → true, dialGroupIds → [${dialGroupIds.join(",")}]`);
        // RingCX's PUT requires the FULL agent payload echoed back,
        // not a sparse patch. Merge our changes into the existing
        // record so we don't drop fields the server requires.
        const fullPayload = { ...agent, ...patch };
        try {
          const updated = await client.updateAgent(agent.agentId || agent.id, fullPayload, existingAgentGroupId);
          agent = { ...agent, ...updated };
          logBullet(`✅ patched`);
        } catch (e) {
          console.error(`updateAgent failed: ${e.message}`);
          if (e?.details?.responseBody) console.error(`   response: ${JSON.stringify(e.details.responseBody)}`);
          // Fall back: try a sparse patch with just the dial group attach,
          // which is the most important change for dialing to work.
          if (dialGroupId && !(agent.dialGroupIds || []).includes(dialGroupId)) {
            try {
              await client.updateAgent(agent.agentId || agent.id, { dialGroupIds }, existingAgentGroupId);
              logBullet(`✅ fallback dialGroup-only patch succeeded`);
            } catch (e2) {
              console.error(`fallback patch also failed: ${e2.message}`);
              if (e2?.details?.responseBody) console.error(`   response: ${JSON.stringify(e2.details.responseBody)}`);
            }
          }
        }
      }
    } else {
      logBullet(`agent already in desired state — no patch needed`);
    }

    // Drop the placeholder agent group we just created (the one we
    // would have put the new agent into). Keep the group the existing
    // agent actually lives in.
    if (agentGroupId && existingAgentGroupId && agentGroupId !== existingAgentGroupId) {
      logBullet(`note: empty agent group ${agentGroupId} was created this run; existing agent lives in group ${existingAgentGroupId}. The placeholder is harmless but you can delete it from the admin UI.`);
    }
  } else if (dry) {
    logBullet(`would CREATE agent ${agentEmail} linked to rcUserId=${agentRcUserId || "(none)"}`);
  } else if (agentGroupId) {
    logBullet(`creating agent ${agentEmail}...`);
    try {
      // Note: firstName/lastName here are best-effort. The discover
      // script could enrich these via an extension lookup but for
      // now they fall back to the admin's name (from the auth call)
      // when the agent is different (ballen ≠ mgray) — easy to edit
      // in the UI after creation.
      // Permissions to set on initial create — RingCX defaults
      // `allowOutbound: false` which would block placeManualCall.
      // We turn on the outbound dial set explicitly.
      const firstName = readFlag(argv, "--agent-first-name") || "Bryce";
      const lastName = readFlag(argv, "--agent-last-name") || "Allen";
      agent = await client.createAgent({
        agentExternId: agentEmail,                       // login id; usually email
        username: agentEmail,
        firstName,
        lastName,
        email: agentEmail,
        rcUserId: agentRcUserId ? Number(agentRcUserId) : undefined,
        isActive: 1,
        dialGroupIds: [dialGroupId].filter(Boolean),
        initLoginBaseState: "AVAILABLE",
        allowOutbound: true,
        allowManualCalls: true,
        allowInbound: true,
        allowHold: true,
        allowTransfer: true,
        allowHangup: true,
        // allowOffHook = "agent can bind to a phone session". Controls
        // BOTH external SIP phones AND the integrated softphone — RingCX
        // routes the WebRTC softphone through the same off-hook
        // session machinery. Without this, the agent dashboard throws
        // "you are not allowed to go off hook" when trying to set
        // AVAILABLE, and createManualAgentCall returns
        // "no offhook session for agent". Default in the create API is
        // false; explicit true here.
        allowOffHook: true,
      }, agentGroupId);
      logBullet(`created: id=${agent.agentId || agent.id}`);
    } catch (e) {
      // Common failures: rcUserId not licensed for RingCX, agentExternId already taken at the account level.
      console.error(`createAgent failed: ${e.message}`);
      console.error(`  → most likely the RC user (${agentEmail}) doesn't have an RingCX agent license,`);
      console.error(`    or the username is already used in another agent group on this account.`);
    }
  }

  // ── 4. Test campaign ─────────────────────────────────────────────
  logHeader("4. Test Campaign");
  let existingCampaigns = [];
  if (dialGroupId && !dry) {
    try { existingCampaigns = await client.listCampaigns(dialGroupId); } catch (e) { console.error("listCampaigns failed:", e.message); }
  }
  let campaign = await findByName(existingCampaigns, "campaignName", campaignName);
  if (campaign) {
    logBullet(`reusing existing campaign: ${campaign.campaignName} (id=${campaign.campaignId})`);
    const desiredCampaignPatch = {
      surveyPopType: "",
      dispositionTimeout: 5,
      afterCallBaseState: "AVAILABLE",
      afterCallState: { id: availableStateId, description: "Available" },
    };
    const needsCampaignPatch =
      campaign.surveyPopType !== desiredCampaignPatch.surveyPopType
      || Number(campaign.dispositionTimeout || 0) !== 5
      || String(campaign.afterCallBaseState || "").toUpperCase() !== "AVAILABLE"
      || Number(campaign.afterCallState?.id || 0) !== availableStateId;
    if (needsCampaignPatch) {
      if (dry) {
        logBullet(`would PATCH campaign: ${JSON.stringify(desiredCampaignPatch)}`);
      } else {
        const fullPayload = { ...campaign, ...desiredCampaignPatch };
        campaign = await client.updateCampaign(campaign.campaignId || campaign.id, fullPayload, dialGroupId);
        logBullet("patched campaign: suppress dispositions, after-call state -> AVAILABLE");
      }
    }
  } else if (dry) {
    logBullet(`would CREATE campaign "${campaignName}" (callerId=${callerId})`);
  } else if (dialGroupId) {
    logBullet(`creating campaign "${campaignName}"...`);
    try {
      const today = new Date();
      const startDate = today.toISOString();
      const endDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()).toISOString();
      campaign = await client.createCampaign({
        campaignName,
        campaignDesc: "Auto-created by scripts/rcx-voice-bootstrap.js — used for end-to-end smoke tests",
        isActive: 1,
        campaignPriority: 3,
        startDate,
        endDate,
        maxRingTime: 30,
        maxRingTimeTransfer: 60,
        callerId,
        scrubDisconnectNoanswer: 0,
        // dialLoadedOrder: 1 = FIFO (oldest queued lead dialed first).
        // Default 0 is "no specific order" which the engine treats as
        // LIFO-ish (highest leadId first). For a cadence engine that
        // loads leads as they age in, FIFO is almost always what you
        // want so older leads don't get permanently buried by fresh
        // intake.
        dialLoadedOrder: 1,
        machineDetect: false,
        trackSpeedToLead: 0,
        // Parallel owns the real disposition/status logic in Logics.
        // RingCX is only the progressive dialer. Let RingCX's campaign
        // auto-disposition timer clear the agent from Working, then
        // send them back to Available.
        surveyPopType: "",
        dispositionTimeout: 5,
        afterCallBaseState: "AVAILABLE",
        afterCallState: { id: availableStateId, description: "Available" },
      }, dialGroupId);
      logBullet(`created: id=${campaign.campaignId}`);
    } catch (e) {
      console.error(`createCampaign failed: ${e.message}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  logHeader("Bootstrap summary");
  logKv("dialGroupId", dialGroupId || "—");
  logKv("agentGroupId", agentGroupId || "—");
  logKv("agentId", agent?.agentId || agent?.id || "—");
  logKv("campaignId", campaign?.campaignId || campaign?.id || "—");
  logKv("callerId", callerId);

  if (!dry) {
    logHeader("Refreshing .env via rcx-voice-discover.js");
    const result = spawnSync("node", [path.join(__dirname, "rcx-voice-discover.js"), "--append"], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`discover --append exited with ${result.status}`);
    }
  }

  logHeader("Next steps (PROGRESSIVE / POWER mode)");
  console.log("  1. Attach the agent to the dial group via admin UI — the API path is");
  console.log("     blocked for RC-synced agents (rc.sync.validation rule):");
  console.log(`     RingCX admin → Outbound → Dial Groups → ${dialGroupName} → Members → add ${agentEmail}`);
  console.log("");
  console.log("  2. Have ballen open the agent dashboard:");
  console.log("     https://ringcx.ringcentral.com/voice/agent/");
  console.log("     - Sign in via SSO as ballen@taxadvocategroup.com");
  console.log("     - Pick 'Integrated Softphone' as the device (browser WebRTC)");
  console.log("     - Allow microphone access when prompted");
  console.log(`     - Select dial group "${dialGroupName}" (top-right device picker)`);
  console.log("     - Set state to AVAILABLE (state id 5877)");
  console.log("");
  console.log("  3. With the agent AVAILABLE in the dial group, run the lead-load step:");
  console.log("     node scripts/rcx-voice-dial.js --to +18181234567");
  console.log("     The system will auto-dial as soon as the lead lands in the queue.");
  console.log("     ballen's softphone will ring; she takes the call; she dispositions");
  console.log("     in the agent dashboard; system fetches the next lead.");
}

main().catch((e) => {
  console.error("\nfatal:", e.message);
  if (e?.details) console.error(JSON.stringify(e.details, null, 2));
  process.exit(1);
});
