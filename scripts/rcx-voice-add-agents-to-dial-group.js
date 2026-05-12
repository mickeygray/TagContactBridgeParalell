"use strict";

// Attach RingCX agents to the dial group that owns the active CX campaign.
//
// RingCX campaigns are nested under dial groups. In practice, "add this
// agent to the campaign" means "add this agent to the campaign's dial group".
//
// Usage:
//   node scripts/rcx-voice-add-agents-to-dial-group.js --list
//   node scripts/rcx-voice-add-agents-to-dial-group.js --agent-email polson@taxadvocategroup.com --dry
//   node scripts/rcx-voice-add-agents-to-dial-group.js --agent-email polson@taxadvocategroup.com --agent-email slucas@taxadvocategroup.com
//   node scripts/rcx-voice-add-agents-to-dial-group.js --dial-group-id 963 --campaign-id 2306 --agent-email polson@taxadvocategroup.com

const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function readMultiFlag(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    } else if (arg === name && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter((cells) => cells.some((cell) => String(cell || "").trim()))
    .map((cells) => Object.fromEntries(headers.map((header, idx) => [header, cells[idx] || ""])));
}

function loadRcExtensionRows() {
  const csvPath = path.resolve(__dirname, "../ops/ringcentral-reference/rc-extensions.csv");
  if (!fs.existsSync(csvPath)) return [];
  return parseCsv(fs.readFileSync(csvPath, "utf8"));
}

function findRcExtensionForEmailOrName(email, extensionRows) {
  const prefix = String(email || "").split("@")[0].trim().toLowerCase();
  const explicit = {
    acordero: "Alazey Cordero",
    abanks: "Alexander Banks",
    awells: "Andrew Wells",
    slucas: "Sean Lucas",
    acalloway: "Anthony Calloway",
    ballen: "Bruce Allen",
    dpearson: "Dani Pearson",
    jrose: "Jackie Rose",
    jsantos: "Jacqueline Santos",
    jwallace: "Jake Wallace",
    jharo: "Jonathan Haro",
    jpineda: "Jonathan Pineda",
    lcollins: "Leo Collins",
    manderson: "Matthew Anderson",
    mgray: "Michael Gray",
    mcazares: "Monica Cazares",
    nramirez: "Neyla Ramirez",
    polson: "Phil Olson",
    rmills: "Riley Mills",
  }[prefix];
  if (!explicit) return null;
  return extensionRows.find((row) =>
    String(row.Name || "").trim().toLowerCase().includes(explicit.toLowerCase())
      && String(row.Status || "").trim().toLowerCase() === "enabled"
      && String(row.Type || "").trim().toLowerCase() === "user"
      && !String(row.Name || "").toLowerCase().includes("wynn")
      && !String(row.Name || "").toLowerCase().includes("amity")
  ) || null;
}

function splitName(name, email) {
  const clean = String(name || "").replace(/\s+-\s+TAG$/i, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
    };
  }
  const prefix = String(email || "").split("@")[0] || "agent";
  return {
    firstName: prefix,
    lastName: "Agent",
  };
}

function normalizeId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function sameId(left, right) {
  return String(left || "").trim() === String(right || "").trim();
}

function logHeader(label) {
  console.log(`\n== ${label} ==`);
}

function logKv(label, value) {
  console.log(`  ${String(label).padEnd(22)} ${value == null || value === "" ? "-" : value}`);
}

async function findAgents(client) {
  const groups = await client.listAgentGroups();
  const rows = [];
  for (const group of groups || []) {
    const agentGroupId = group.agentGroupId || group.id;
    if (!agentGroupId) continue;
    let agents = [];
    try {
      agents = await client.listAgents(agentGroupId);
    } catch (error) {
      console.error(`Could not list agents for group ${agentGroupId}: ${error.message}`);
      continue;
    }
    for (const agent of agents || []) {
      rows.push({
        agent,
        agentGroupId,
        agentGroupName: group.agentGroupName || group.groupName || group.name || "",
      });
    }
  }
  return rows;
}

function agentEmail(agent) {
  return String(agent.username || agent.email || agent.agentExternId || "").trim().toLowerCase();
}

function emailLocal(value) {
  return String(value || "").trim().toLowerCase().split("@")[0].split("+")[0];
}

function agentId(agent) {
  return agent.agentId || agent.id;
}

async function maybeLoadFullAgent(client, row) {
  try {
    const full = await client.getAgent(agentId(row.agent), row.agentGroupId);
    return {
      ...row,
      agent: full,
    };
  } catch {
    return row;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = hasFlag(argv, "--dry") || hasFlag(argv, "--dry-run");
  const listOnly = hasFlag(argv, "--list");
  const createMissing = hasFlag(argv, "--create-missing");
  const targetEmails = readMultiFlag(argv, "--agent-email");

  const client = createRingcxVoiceClient();
  const dialGroupId = normalizeId(
    readFlag(argv, "--dial-group-id")
      || process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID,
  );
  const campaignId = normalizeId(
    readFlag(argv, "--campaign-id")
      || process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID,
  );

  if (!dialGroupId) {
    throw new Error("No dial group id provided and RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID is not set.");
  }

  logHeader("RingCX target");
  const who = await client.auth.whoami();
  logKv("auth user", who.rcUser?.email);
  logKv("account id", who.accountId);
  logKv("dial group id", dialGroupId);
  logKv("campaign id", campaignId || "(not checked)");

  let targetDialGroupName = "";
  try {
    const dialGroup = await client.getDialGroup(dialGroupId);
    targetDialGroupName = dialGroup?.dialGroupName || dialGroup?.name || "";
    if (targetDialGroupName) logKv("dial group", `${targetDialGroupName} (${dialGroupId})`);
  } catch (error) {
    logKv("dial group", `lookup failed: ${error.message}`);
  }

  if (campaignId) {
    const campaign = await client.getCampaign(campaignId, dialGroupId);
    logKv("campaign", `${campaign.campaignName || campaign.name || "(unnamed)"} (${campaign.campaignId || campaign.id})`);
  }

  const rows = await findAgents(client);
  const hydratedRows = [];
  for (const row of rows) {
    hydratedRows.push(await maybeLoadFullAgent(client, row));
  }

  if (listOnly) {
    logHeader("Agents");
    for (const row of hydratedRows) {
      const agent = row.agent;
      console.log(JSON.stringify({
        email: agentEmail(agent),
        agentId: agentId(agent),
        agentGroupId: row.agentGroupId,
        agentGroupName: row.agentGroupName,
        name: [agent.firstName, agent.lastName].filter(Boolean).join(" "),
        active: agent.isActive ?? agent.active,
        dialGroupIds: agent.dialGroupIds || [],
        phoneLoginDialGroup: agent.phoneLoginDialGroup || null,
        inTargetDialGroup: (agent.dialGroupIds || []).some((id) => sameId(id, dialGroupId))
          || sameId(agent.phoneLoginDialGroup?.id, dialGroupId),
      }));
    }
    return;
  }

  if (targetEmails.length === 0) {
    console.log("\nProvide at least one --agent-email, or use --list to see available agents.");
    process.exitCode = 1;
    return;
  }

  const byEmail = new Map(hydratedRows.map((row) => [agentEmail(row.agent), row]));
  const byLocal = new Map();
  for (const row of hydratedRows) {
    const local = emailLocal(agentEmail(row.agent));
    if (!local) continue;
    if (!byLocal.has(local)) byLocal.set(local, []);
    byLocal.get(local).push(row);
  }
  const targetDialGroupId = normalizeId(dialGroupId);
  const extensionRows = createMissing ? loadRcExtensionRows() : [];

  logHeader(dry ? "Dry run" : "Applying");
  for (const email of targetEmails) {
    let targetRows = [];
    const exact = byEmail.get(email);
    if (exact) targetRows.push(exact);
    for (const localMatch of byLocal.get(emailLocal(email)) || []) {
      if (!targetRows.some((candidate) => agentId(candidate.agent) === agentId(localMatch.agent))) {
        targetRows.push(localMatch);
      }
    }
    if (targetRows.length === 0) {
      if (!createMissing) {
        console.log(`  ${email}: not found as a RingCX agent`);
        continue;
      }
      const rcExtension = findRcExtensionForEmailOrName(email, extensionRows);
      if (!rcExtension?.ID) {
        console.log(`  ${email}: missing RingCX agent and no enabled TAG RingEX extension was found`);
        continue;
      }
      let row;
      const name = splitName(rcExtension.Name, email);
      const createPayload = {
        agentExternId: email,
        username: email,
        email,
        firstName: name.firstName,
        lastName: name.lastName,
        rcUserId: Number(rcExtension.ID),
        isActive: 1,
        active: true,
        agentType: "AGENT",
        dialGroupIds: [targetDialGroupId],
        phoneLoginDialGroup: {
          id: targetDialGroupId,
          description: targetDialGroupName || String(targetDialGroupId),
        },
        initLoginBaseState: "AVAILABLE",
        allowInbound: true,
        allowOutbound: true,
        allowManualCalls: true,
        allowCallControl: true,
        allowHangup: true,
        allowHold: true,
        allowTransfer: true,
        allowLoginControl: true,
        allowLoginUpdates: true,
        allowOffHook: true,
      };
      if (dry) {
        console.log(`  ${email}: would create RingCX agent linked to RC extension ${rcExtension.Extension} (${rcExtension.ID}) and dialGroupIds=[${targetDialGroupId}]`);
        continue;
      }
      try {
        const created = await client.createAgent(createPayload, process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID);
        row = {
          agent: created,
          agentGroupId: process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
          agentGroupName: "",
        };
        console.log(`  ${email}: created RingCX agent ${agentId(created)} linked to RC extension ${rcExtension.Extension}`);
      } catch (error) {
        console.log(`  ${email}: create failed - ${error.message}`);
        if (error?.details?.responseBody) {
          console.log(`    response: ${JSON.stringify(error.details.responseBody)}`);
        }
        continue;
      }
      targetRows = [row];
    }

    for (const row of targetRows) {
      const label = agentEmail(row.agent) || email;
      const currentDialGroupIds = Array.isArray(row.agent.dialGroupIds)
        ? row.agent.dialGroupIds
        : [];
      const alreadyAttached = currentDialGroupIds.some((id) => sameId(id, targetDialGroupId));
      const nextDialGroupIds = alreadyAttached
        ? currentDialGroupIds
        : [
            ...currentDialGroupIds,
            targetDialGroupId,
          ];
      const needsPermissionPatch =
        row.agent.allowOutbound !== true
        || row.agent.allowManualCalls !== true
        || row.agent.allowOffHook !== true
        || row.agent.allowLoginControl !== true
        || row.agent.allowLoginUpdates !== true
        || !sameId(row.agent.phoneLoginDialGroup?.id, targetDialGroupId);
      if (alreadyAttached && !needsPermissionPatch) {
        console.log(`  ${label}: already attached and permissions look ready`);
        continue;
      }

      const payload = {
        ...row.agent,
        isActive: row.agent.isActive ?? row.agent.active ?? true,
        active: row.agent.active ?? true,
        allowOutbound: true,
        allowManualCalls: true,
        allowLoginControl: true,
        allowLoginUpdates: true,
        allowOffHook: true,
        dialGroupIds: nextDialGroupIds,
        phoneLoginDialGroup: {
          id: targetDialGroupId,
          description: targetDialGroupName || row.agent.phoneLoginDialGroup?.description || String(targetDialGroupId),
        },
      };

      if (dry) {
        console.log(`  ${label}: would set dialGroupIds=[${nextDialGroupIds.join(", ")}], phoneLoginDialGroup=${targetDialGroupId}, allowOffHook=true, allowLoginControl=true`);
        continue;
      }

      try {
        await client.updateAgent(agentId(row.agent), payload, row.agentGroupId);
        console.log(`  ${label}: patched ${alreadyAttached ? "permissions" : `dial group ${dialGroupId} + permissions`}`);
      } catch (error) {
        console.log(`  ${label}: API update failed - ${error.message}`);
        if (error?.details?.responseBody) {
          console.log(`    response: ${JSON.stringify(error.details.responseBody)}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
