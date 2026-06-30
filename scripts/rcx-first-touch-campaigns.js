"use strict";

// Provision per-agent RingCX "First Touch" campaigns from one source campaign.
//
// Dry-run by default. Use --apply to create/update campaigns.
//
// Examples:
//   node scripts/rcx-first-touch-campaigns.js --source-dial-group-id 123 --source-campaign-id 456 --target bruce:1001 --target chris:1002
//   node scripts/rcx-first-touch-campaigns.js --source-dial-group-name "Brad First Touch DG" --source-campaign-name "Brad First Touch" --target "Bruce Allen:1001" --apply
//
// Target format:
//   --target key:dialGroupId[:campaignName]
//   key can be bruce, chris, phil, sean, or any display text.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

const AGENT_LABELS = Object.freeze({
  brad: "Brad First Touch",
  bruce: "Bruce First Touch",
  chris: "Chris First Touch",
  phil: "Phil First Touch",
  sean: "Sean First Touch",
});

const COPY_KEYS = Object.freeze([
  "isActive",
  "campaignPriority",
  "startDate",
  "endDate",
  "maxRingTime",
  "maxRingTimeTransfer",
  "callerId",
  "transferCallerId",
  "scrubDisconnectNoanswer",
  "dialLoadedOrder",
  "trackSpeedToLead",
  "machineDetect",
  "dncScrubOption",
  "passDelayMin",
  "whisperMsg",
  "abandonMsg",
  "onHoldMsg",
  "endCallMsg",
  "machAnswerMsg",
  "liveAnswerMsg",
  "maxPasses",
  "maxPassesExclude",
  "maxDailyPasses",
  "maxDailyPassesInclude",
  "maxDialLimit",
  "seedSuccessRate",
  "seedAbandonRate",
  "targetAbandonRate",
  "minPredictiveCallsHistory",
  "showLeadInfo",
  "appUrl",
  "surveyPopType",
  "recordCall",
  "stopRecordingOnTransfer",
  "recordingInConference",
  "agentPopMessage",
  "afterCallBaseState",
  "hangupOnDisposition",
  "allowLeadUpdates",
  "allowLeadInserts",
  "requeueType",
  "showLeadPasses",
  "exportFlag",
  "enableGlobalPhoneBook",
  "aux1Label",
  "aux2Label",
  "aux3Label",
  "aux4Label",
  "aux5Label",
  "showListName",
  "genericKeyValuePairs",
  "filterEnabled",
  "filterType",
  "useGlobalWhitelist",
  "rescrubInterval",
  "pauseRecordingSec",
  "dispositionTimeout",
  "realtimeDncUrl",
  "afterCallState",
]);

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
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
  return values.flatMap((value) => String(value || "").split(",")).map((value) => value.trim()).filter(Boolean);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function campaignId(row) {
  return row?.campaignId || row?.id || "";
}

function campaignName(row) {
  return row?.campaignName || row?.name || "";
}

function dialGroupId(row) {
  return row?.dialGroupId || row?.groupId || row?.id || "";
}

function dialGroupName(row) {
  return row?.dialGroupName || row?.name || row?.description || "";
}

function logHeader(value) {
  console.log(`\n== ${value} ==`);
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(26)} ${value == null || value === "" ? "-" : value}`);
}

function cleanCopy(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(cleanCopy).filter((item) => item !== undefined);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const cleaned = cleanCopy(child);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function buildCampaignPayload(sourceCampaign, targetName) {
  const payload = {
    campaignName: targetName,
    campaignDesc: `First-touch campaign mirrored from ${campaignName(sourceCampaign)}`,
  };
  for (const key of COPY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sourceCampaign, key)) continue;
    const value = cleanCopy(sourceCampaign[key]);
    if (value !== undefined) payload[key] = value;
  }
  if (payload.isActive == null) payload.isActive = 1;
  if (!payload.callerId) throw new Error("Source campaign is missing callerId; refusing to create target campaigns.");
  if (!payload.startDate || !payload.endDate) {
    throw new Error("Source campaign is missing startDate/endDate; refusing to create target campaigns.");
  }
  return payload;
}

function parseTarget(value) {
  const parts = String(value || "").split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid --target "${value}". Use key:dialGroupId[:campaignName].`);
  }
  const key = parts[0].toLowerCase();
  return {
    key,
    dialGroupId: normalizeId(parts[1]),
    campaignName: parts.slice(2).join(":") || AGENT_LABELS[key] || `${parts[0]} First Touch`,
  };
}

async function resolveDialGroup(client, { dialGroupId: explicitId, dialGroupName: explicitName }) {
  if (explicitId) {
    const group = await client.getDialGroup(explicitId);
    return { dialGroupId: normalizeId(explicitId), dialGroup: group };
  }
  if (!explicitName) throw new Error("Provide --source-dial-group-id or --source-dial-group-name.");
  const groups = await client.listDialGroups();
  const target = normalizeName(explicitName);
  const group = (groups || []).find((row) => normalizeName(dialGroupName(row)) === target);
  if (!group) throw new Error(`Could not find source dial group named "${explicitName}".`);
  return { dialGroupId: normalizeId(dialGroupId(group)), dialGroup: group };
}

async function resolveCampaign(client, { sourceDialGroupId, sourceCampaignId, sourceCampaignName }) {
  if (sourceCampaignId) {
    const campaign = await client.getCampaign(sourceCampaignId, sourceDialGroupId);
    return { campaignId: normalizeId(sourceCampaignId), campaign };
  }
  if (!sourceCampaignName) throw new Error("Provide --source-campaign-id or --source-campaign-name.");
  const campaigns = await client.listCampaigns(sourceDialGroupId);
  const target = normalizeName(sourceCampaignName);
  const campaign = (campaigns || []).find((row) => normalizeName(campaignName(row)) === target);
  if (!campaign) throw new Error(`Could not find source campaign named "${sourceCampaignName}" in dial group ${sourceDialGroupId}.`);
  const id = campaignId(campaign);
  return { campaignId: normalizeId(id), campaign: await client.getCampaign(id, sourceDialGroupId) };
}

async function findCampaignByName(client, targetDialGroupId, targetName) {
  const rows = await client.listCampaigns(targetDialGroupId);
  const normalized = normalizeName(targetName);
  return (rows || []).find((row) => normalizeName(campaignName(row)) === normalized) || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "--apply");
  const updateExisting = hasFlag(argv, "--update-existing");
  const targets = readMultiFlag(argv, "--target").map(parseTarget);

  if (targets.length === 0) {
    throw new Error("Provide one or more --target key:dialGroupId[:campaignName] values.");
  }

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();

  logHeader("Auth");
  logKv("auth user", who.rcUser?.email || "(unknown)");
  logKv("account id", who.accountId);
  logKv("mode", apply ? "APPLY" : "DRY RUN");
  logKv("update existing", updateExisting ? "yes" : "no");

  const sourceDialGroup = await resolveDialGroup(client, {
    dialGroupId: normalizeId(readFlag(argv, "--source-dial-group-id", "")),
    dialGroupName: readFlag(argv, "--source-dial-group-name", ""),
  });
  const source = await resolveCampaign(client, {
    sourceDialGroupId: sourceDialGroup.dialGroupId,
    sourceCampaignId: normalizeId(readFlag(argv, "--source-campaign-id", "")),
    sourceCampaignName: readFlag(argv, "--source-campaign-name", ""),
  });

  logHeader("Source");
  logKv("dial group", `${dialGroupName(sourceDialGroup.dialGroup)} (${sourceDialGroup.dialGroupId})`);
  logKv("campaign", `${campaignName(source.campaign)} (${source.campaignId})`);
  logKv("caller id", source.campaign.callerId);
  logKv("dial loaded order", source.campaign.dialLoadedOrder);
  logKv("surveyPopType", source.campaign.surveyPopType || "(blank/native)");
  logKv("disposition timeout", source.campaign.dispositionTimeout);
  logKv("after-call state", source.campaign.afterCallBaseState || source.campaign.afterCallState?.description || "");

  for (const target of targets) {
    logHeader(target.campaignName);
    logKv("target dial group id", target.dialGroupId);
    const payload = buildCampaignPayload(source.campaign, target.campaignName);
    const existing = await findCampaignByName(client, target.dialGroupId, target.campaignName);
    if (existing && !updateExisting) {
      logKv("existing campaign", `${campaignName(existing)} (${campaignId(existing)})`);
      logKv("action", "skip (pass --update-existing to patch)");
      continue;
    }

    logKv("action", existing ? "update" : "create");
    logKv("payload", JSON.stringify({
      campaignName: payload.campaignName,
      isActive: payload.isActive,
      callerId: payload.callerId,
      dialLoadedOrder: payload.dialLoadedOrder,
      surveyPopType: payload.surveyPopType || "",
      dispositionTimeout: payload.dispositionTimeout,
      afterCallBaseState: payload.afterCallBaseState,
    }));

    if (!apply) continue;

    const result = existing
      ? await client.updateCampaign(campaignId(existing), { ...existing, ...payload }, target.dialGroupId)
      : await client.createCampaign(payload, target.dialGroupId);
    const id = campaignId(result);
    const verified = id ? await client.getCampaign(id, target.dialGroupId) : result;
    logKv("result", `${campaignName(verified)} (${campaignId(verified) || id})`);
    logKv("verified surveyPopType", verified.surveyPopType || "(blank/native)");
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});
