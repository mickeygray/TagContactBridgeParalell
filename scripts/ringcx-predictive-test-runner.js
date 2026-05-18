"use strict";

// RingCX predictive dialer batch test runner.
//
// Purpose:
//   Fast operator harness for a live predictive-campaign test without
//   building a new frontend first.
//
// What it does:
//   1. Resolves/verifies the target dial group and campaign.
//   2. Parses either a CSV file, TXT file, comma-separated phone list, or stdin.
//   3. Builds RingCX leadLoader/direct payloads with dialPriority=IMMEDIATE.
//   4. Loads leads in controlled batches only when --live is supplied.
//   5. Optionally checks named agents' RingCX login/off-hook state.
//   6. Optionally watches activeCalls/list for the loaded phone numbers.
//
// Safety:
//   - Dry-run by default. Use --live to actually modify RingCX.
//   - Does not start/stop campaigns. Agents should log into the campaign/dial
//     group in the RingCX client; RingCX predictive pacing owns delivery.
//   - Does not cancel loaded leads unless --cancel-loaded is explicitly passed.
//
// Example:
//   node scripts/ringcx-predictive-test-runner.js --dial-group-id 123 --campaign-id 456 --csv .\leads.csv
//   node scripts/ringcx-predictive-test-runner.js --dial-group-id 123 --campaign-id 456 --phones 12026046409,13106665997 --live
//   node scripts/ringcx-predictive-test-runner.js --dial-group-name "Master Blaster" --campaign-name "Bulk Dial Test" --txt .\phones.txt --batch-size 50 --batch-interval-minutes 10 --live
//   node scripts/ringcx-predictive-test-runner.js --dial-group-id 1055 --campaign-id 2435 --csv .\leads.csv --max-leads 100 --batch-size 100 --live
//   node scripts/ringcx-predictive-test-runner.js --dial-group-id 1055 --campaign-id 2435 --csv .\leads.csv --skip-leads 50 --max-leads 50 --batch-size 50 --live
//   node scripts/ringcx-predictive-test-runner.js --dial-group-name "Master Blaster" --campaign-name "Bulk Dial Test" --resolve-only

const fs = require("fs");
const path = require("path");
const readline = require("readline");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function splitList(value) {
  return String(value || "")
    .split(/[,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function logHeader(value) {
  console.log(`\n=== ${value} ===`);
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(28)} ${value == null || value === "" ? "(none)" : value}`);
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePhone(value, { stripLeadingOne = false } = {}) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (stripLeadingOne && digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

function splitName(row = {}) {
  const first = String(pickFirst(row, [
    "firstName",
    "first_name",
    "firstname",
    "FirstName",
    "First Name",
    "first",
  ]) || "").trim();
  const last = String(pickFirst(row, [
    "lastName",
    "last_name",
    "lastname",
    "LastName",
    "Last Name",
    "last",
  ]) || "").trim();
  if (first || last) return { firstName: first || "Predictive", lastName: last || "Test" };

  const full = String(pickFirst(row, [
    "name",
    "Name",
    "fullName",
    "full_name",
    "Full Name",
    "customerName",
    "Customer Name",
  ]) || "").trim();
  if (!full) return { firstName: "Predictive", lastName: "Test" };
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || "Predictive",
    lastName: parts.join(" ") || "Test",
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  row.push(field);
  if (row.some((cell) => String(cell || "").trim())) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows[0].map((cell) => String(cell || "").trim());
  const headerLooksReal = headers.some((header) =>
    /phone|cell|mobile|number|first|last|name|case|source|extern|email/i.test(header),
  );

  if (!headerLooksReal) {
    return rows
      .map((cells) => ({ phone: cells[0], firstName: cells[1], lastName: cells[2], raw: cells }))
      .filter((r) => String(r.phone || "").trim());
  }

  return rows.slice(1).map((cells) => {
    const out = {};
    headers.forEach((header, idx) => {
      if (header) out[header] = cells[idx] == null ? "" : cells[idx];
    });
    return out;
  });
}

function pickFirst(row, keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== "") return row[key];
  }
  const entries = Object.entries(row || {});
  for (const key of keys) {
    const target = String(key || "").trim().toLowerCase();
    const hit = entries.find(([candidate, value]) =>
      String(candidate || "").trim().toLowerCase() === target
      && value != null
      && String(value).trim() !== "",
    );
    if (hit) return hit[1];
  }
  return "";
}

function loadRowsFromFile(filePath) {
  const absolute = path.resolve(filePath);
  const text = fs.readFileSync(absolute, "utf8");
  if (/\.csv$/i.test(absolute)) return parseCsv(text);
  return splitList(text).map((phone) => ({ phone }));
}

async function readStdinRows() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return splitList(lines.join("\n")).map((phone) => ({ phone }));
}

function buildLead(row, index, options = {}) {
  const rawPhone = pickFirst(row, [
    "phone",
    "leadPhone",
    "lead_phone",
    "Phone",
    "PHONE",
    "Cell",
    "mobile",
    "Mobile",
    "cell",
    "number",
    "Phone Number",
    "phoneNumber",
    "primaryPhone",
    "Primary Phone",
  ]);
  const leadPhone = normalizePhone(rawPhone, {
    stripLeadingOne: options.stripLeadingOne,
  });
  if (!leadPhone) return null;

  const { firstName, lastName } = splitName(row);
  const externId = String(
    pickFirst(row, [
      "externId",
      "extern_id",
      "externalId",
      "leadId",
      "Lead ID",
      "id",
      "caseId",
      "case_id",
      "Case #",
      "Case",
      "caseNumber",
      "Case Number",
    ])
      || `${options.externPrefix}-${Date.now()}-${String(index + 1).padStart(4, "0")}`,
  ).replace(/\s+/g, "-").slice(0, 120);

  const extendedLeadData = {
    source: "parallel-predictive-test",
    testRunId: options.runId,
    rowNumber: index + 1,
  };

  for (const [target, keys] of Object.entries({
    domain: ["domain", "company"],
    caseId: ["caseId", "case_id", "Case #", "Case", "caseNumber", "Case Number", "LogicsID", "logicsId"],
    sourceName: ["source", "sourceName", "vendor", "campaignSource"],
    note: ["note", "notes"],
  })) {
    const value = pickFirst(row, keys);
    if (value !== "") extendedLeadData[target] = value;
  }

  const email = pickFirst(row, ["email", "Email"]);

  return {
    externId,
    leadPhone,
    firstName,
    lastName,
    email: email || undefined,
    extendedLeadData,
  };
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeResponse(value) {
  if (value == null) return value;
  const json = JSON.stringify(value);
  return json.length > 700 ? `${json.slice(0, 700)}...` : json;
}

function containsAnyPhone(row, lastTenPhones) {
  const raw = JSON.stringify(row || "");
  return lastTenPhones.some((phone) => raw.includes(phone.slice(-10)));
}

async function resolveCampaign(client, { dialGroupId, dialGroupName, campaignId, campaignName }) {
  let resolvedDialGroupId = normalizeId(dialGroupId);
  let dialGroup = null;
  if (resolvedDialGroupId) {
    dialGroup = await client.getDialGroup(resolvedDialGroupId).catch((error) => ({
      error: error.message,
      details: error.details || null,
    }));
  } else if (dialGroupName) {
    const target = normalizeName(dialGroupName);
    const dialGroups = await client.listDialGroups();
    dialGroup = (dialGroups || []).find((row) =>
      [
        row.dialGroupName,
        row.name,
        row.label,
        row.groupName,
      ].some((candidate) => normalizeName(candidate) === target),
    );
    resolvedDialGroupId = normalizeId(dialGroup?.dialGroupId || dialGroup?.id);
  }

  let resolvedCampaignId = normalizeId(campaignId);
  let campaign = null;

  if (resolvedCampaignId && resolvedDialGroupId) {
    campaign = await client.getCampaign(resolvedCampaignId, resolvedDialGroupId).catch((error) => ({
      error: error.message,
      details: error.details || null,
    }));
  } else if (resolvedDialGroupId && campaignName) {
    const campaigns = await client.listCampaigns(resolvedDialGroupId);
    const target = String(campaignName).trim().toLowerCase();
    campaign = (campaigns || []).find((row) =>
      String(row.campaignName || row.name || "").trim().toLowerCase() === target,
    );
    resolvedCampaignId = normalizeId(campaign?.campaignId || campaign?.id);
  }

  return {
    dialGroupId: resolvedDialGroupId,
    campaignId: resolvedCampaignId,
    dialGroup,
    campaign,
  };
}

async function findAgents(client, agentEmails = [], dialGroupId = "") {
  const targets = new Set(agentEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean));
  if (targets.size === 0) return [];

  const groups = await client.listAgentGroups();
  const out = [];
  for (const group of groups || []) {
    const agentGroupId = group.agentGroupId || group.id;
    if (!agentGroupId) continue;
    const agents = await client.listAgents(agentGroupId).catch(() => []);
    for (const agent of agents || []) {
      const username = String(agent.username || agent.email || "").trim().toLowerCase();
      const email = String(agent.email || "").trim().toLowerCase();
      const local = username.split("+")[0];
      const isHit =
        targets.has(username)
        || targets.has(email)
        || [...targets].some((target) => username.startsWith(`${target.split("@")[0]}+`) || local === target.split("@")[0]);
      if (!isHit) continue;

      const full = await client.getAgent(agent.agentId || agent.id, agentGroupId).catch(() => agent);
      const login = await client.getAgentLogin(full.agentId || full.id, agentGroupId).catch(() => null);
      const loginText = JSON.stringify(login || {}).toLowerCase();
      const dialGroupIds = Array.isArray(full.dialGroupIds) ? full.dialGroupIds.map(String) : [];
      out.push({
        agentId: full.agentId || full.id || null,
        agentGroupId,
        username: full.username || full.email || "",
        rcUserId: full.rcUserId || null,
        allowOutbound: full.allowOutbound ?? null,
        allowManualCalls: full.allowManualCalls ?? null,
        allowOffHook: full.allowOffHook ?? null,
        inDialGroup:
          dialGroupId
          && (
            dialGroupIds.includes(String(dialGroupId))
            || String(full.phoneLoginDialGroup?.id || "") === String(dialGroupId)
          ),
        loginPresent: Boolean(login),
        connectedLike:
          /\bconnected\b/.test(loginText)
          || /\boff\s*-?\s*hook\b/.test(loginText)
          || /offhook/.test(loginText),
        availableLike: /\bavailable\b/.test(loginText),
        state:
          login?.agentState
          || login?.agentAuxState
          || login?.state
          || null,
      });
    }
  }
  return out;
}

async function watchActiveCalls(client, { campaignId, dialGroupId, phones, seconds }) {
  const lastTenPhones = phones.map((phone) => phone.slice(-10)).filter(Boolean);
  const start = Date.now();
  const deadline = start + Math.max(Number(seconds) || 0, 0) * 1000;
  const seen = new Map();
  let observations = 0;

  while (Date.now() < deadline) {
    const response = await client.listActiveCalls({
      product: "ACCOUNT",
      productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
    });
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(response?.records)
        ? response.records
        : Array.isArray(response?.content)
          ? response.content
          : [];
    observations += 1;
    for (const row of rows) {
      const raw = JSON.stringify(row || "");
      const id = String(row.uii || row.UII || row.callId || row.callID || row.activeCallId || row.interactionId || raw.slice(0, 80));
      const matchesRoute =
        (campaignId && raw.includes(String(campaignId)))
        || (dialGroupId && raw.includes(String(dialGroupId)))
        || containsAnyPhone(row, lastTenPhones);
      if (!matchesRoute || seen.has(id)) continue;
      seen.set(id, {
        firstSeenMs: Date.now() - start,
        id,
        state: row.state || row.callState || row.status || row.dialState || null,
        agentId: row.agentId || row.agent?.agentId || row.agent?.id || null,
        phone: maskPhone(row.phone || row.destination || row.leadPhone || row.customerPhone || row.dnis || row.ani || ""),
      });
    }
    await sleep(1000);
  }

  return {
    observations,
    matchedActiveCalls: [...seen.values()],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const live = hasFlag(argv, "--live");
  const resolveOnly = hasFlag(argv, "--resolve-only");
  const csv = readFlag(argv, "--csv", "");
  const txt = readFlag(argv, "--txt", "");
  const phonesFlag = readFlag(argv, "--phones", "");
  const stdin = hasFlag(argv, "--stdin");
  const dialGroupId = readFlag(argv, "--dial-group-id", process.env.RINGCX_PREDICTIVE_TEST_DIAL_GROUP_ID || "");
  const dialGroupName = readFlag(argv, "--dial-group-name", process.env.RINGCX_PREDICTIVE_TEST_DIAL_GROUP_NAME || "");
  const campaignId = readFlag(argv, "--campaign-id", process.env.RINGCX_PREDICTIVE_TEST_CAMPAIGN_ID || "");
  const campaignName = readFlag(argv, "--campaign-name", process.env.RINGCX_PREDICTIVE_TEST_CAMPAIGN_NAME || "");
  const agents = splitList(readFlag(argv, "--agents", ""));
  const stripLeadingOne = hasFlag(argv, "--strip-leading-1");
  const skipLeads = Math.max(Number(readFlag(argv, "--skip-leads", "0")) || 0, 0);
  const maxLeads = Math.max(Number(readFlag(argv, "--max-leads", "0")) || 0, 0);
  const batchSize = Math.max(Number(readFlag(argv, "--batch-size", "100")) || 100, 1);
  const batchIntervalMinutes = Number(readFlag(argv, "--batch-interval-minutes", ""));
  const batchDelayMs = Math.max(
    Number.isFinite(batchIntervalMinutes) && batchIntervalMinutes > 0
      ? batchIntervalMinutes * 60 * 1000
      : Number(readFlag(argv, "--batch-delay-ms", "1500")) || 0,
    0,
  );
  const watchSec = Math.max(Number(readFlag(argv, "--watch-sec", live ? "120" : "0")) || 0, 0);
  const leadAction = readFlag(argv, "--lead-action", "");
  const cancelLoaded = hasFlag(argv, "--cancel-loaded");
  const runId = readFlag(argv, "--run-id", `predictive-test-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const externPrefix = readFlag(argv, "--extern-prefix", runId);

  logHeader("RingCX predictive test runner");
  logKv("mode", live ? "LIVE RingCX writes enabled" : "dry-run only");
  logKv("dialGroupId", dialGroupId || "(resolve by --dial-group-name if supplied)");
  logKv("dialGroupName", dialGroupName || "(none)");
  logKv("campaignId", campaignId || "(resolve by --campaign-name if supplied)");
  logKv("campaignName", campaignName || "(none)");
  logKv("runId", runId);
  logKv("skipLeads", skipLeads || 0);
  logKv("maxLeads", maxLeads || "(all supplied)");
  logKv("batchSize", batchSize);
  logKv("batchDelayMs", batchDelayMs);
  logKv("watchSec", watchSec);
  logKv("phone format", stripLeadingOne ? "strip leading 1" : "preserve digits as supplied");

  let inputRows = [];
  if (csv) inputRows = inputRows.concat(loadRowsFromFile(csv));
  if (txt) inputRows = inputRows.concat(loadRowsFromFile(txt));
  if (phonesFlag) inputRows = inputRows.concat(splitList(phonesFlag).map((phone) => ({ phone })));
  if (stdin) inputRows = inputRows.concat(await readStdinRows());

  if (inputRows.length === 0 && !resolveOnly) {
    console.error("\nNo leads supplied. Use --csv, --txt, --phones, or --stdin.");
    process.exit(1);
  }

  let leads = inputRows
    .map((row, index) => buildLead(row, index, { stripLeadingOne, runId, externPrefix }))
    .filter(Boolean);
  if (skipLeads > 0) {
    leads = leads.slice(skipLeads);
  }
  if (maxLeads > 0 && leads.length > maxLeads) {
    leads = leads.slice(0, maxLeads);
  }
  const skipped = inputRows.length - leads.length;
  if (leads.length === 0 && !resolveOnly) {
    console.error("\nNo dialable leads after phone normalization.");
    process.exit(1);
  }

  if (!resolveOnly) {
    logHeader("Input");
    logKv("rows read", inputRows.length);
    logKv("dialable leads", leads.length);
    logKv("not loaded/skipped", skipped);
    logKv("first phone", maskPhone(leads[0].leadPhone));
    logKv("last phone", maskPhone(leads[leads.length - 1].leadPhone));
  }

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();
  logHeader("Auth");
  logKv("rcUser", who.rcUser?.email || "(unknown)");
  logKv("accountId", who.accountId || "(unknown)");

  const resolved = await resolveCampaign(client, { dialGroupId, dialGroupName, campaignId, campaignName });
  if (!resolved.dialGroupId) {
    console.error("\nMissing dial group. Pass --dial-group-id or --dial-group-name.");
    process.exit(1);
  }
  if (!resolved.campaignId) {
    console.error("\nMissing campaign. Pass --campaign-id or --campaign-name with --dial-group-id.");
    process.exit(1);
  }

  logHeader("Target");
  logKv("dial group", `${resolved.dialGroup?.dialGroupName || resolved.dialGroup?.name || "(name unknown)"} (${resolved.dialGroupId})`);
  logKv("dial mode", resolved.dialGroup?.dialMode || resolved.dialGroup?.dialerMode || "(unknown)");
  logKv("campaign", `${resolved.campaign?.campaignName || resolved.campaign?.name || "(name unknown)"} (${resolved.campaignId})`);
  logKv("campaign active", resolved.campaign?.isActive ?? "(unknown)");
  logKv("campaign callerId", resolved.campaign?.callerId || "(unknown)");

  const mode = String(resolved.dialGroup?.dialMode || resolved.dialGroup?.dialerMode || "").toUpperCase();
  if (mode && mode !== "PREDICTIVE") {
    console.warn(`\nWARNING: target dial group mode is ${mode}, not PREDICTIVE.`);
  }

  if (resolveOnly) {
    logHeader("Resolve-only complete");
    console.log(`  Use: --dial-group-id ${resolved.dialGroupId} --campaign-id ${resolved.campaignId}`);
    return;
  }

  if (agents.length > 0) {
    logHeader("Agent readiness");
    const agentRows = await findAgents(client, agents, resolved.dialGroupId);
    for (const agent of agentRows) {
      logKv(agent.username, `id=${agent.agentId} group=${agent.agentGroupId} inDialGroup=${agent.inDialGroup} connected=${agent.connectedLike} available=${agent.availableLike} state=${agent.state || "(none)"}`);
    }
    const foundUsernames = new Set(agentRows.map((row) => String(row.username || "").toLowerCase()));
    for (const requested of agents) {
      const local = requested.split("@")[0].toLowerCase();
      const found = [...foundUsernames].some((username) =>
        username === requested.toLowerCase() || username.startsWith(`${local}+`),
      );
      if (!found) console.warn(`  missing agent match for ${requested}`);
    }
  }

  const batches = chunk(leads, batchSize);
  logHeader(live ? "Loading leads" : "Dry-run lead payload");
  logKv("batches", batches.length);
  logKv("endpoint", `/voice/api/v1/admin/accounts/${process.env.RINGCX_VOICE_ACCOUNT_ID || "{accountId}"}/campaigns/${resolved.campaignId}/leadLoader/direct`);

  const loadedExternIds = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const payload = {
      description: `Parallel predictive test ${runId} batch ${index + 1}/${batches.length}`,
      dialPriority: "IMMEDIATE",
      duplicateHandling: "REMOVE_FROM_LIST",
      listState: "ACTIVE",
      timeZoneOption: "NPA_NXX",
      phoneNumbersI18nEnabled: false,
      internationalNumberFormat: false,
      uploadLeads: batch,
      dncTags: [],
    };

    logKv(`batch ${index + 1}`, `${batch.length} leads; first=${maskPhone(batch[0].leadPhone)} last=${maskPhone(batch[batch.length - 1].leadPhone)}`);
    if (!live) {
      if (index === 0) {
        console.log(JSON.stringify({
          ...payload,
          uploadLeads: payload.uploadLeads.slice(0, 3).map((lead) => ({
            ...lead,
            leadPhone: maskPhone(lead.leadPhone),
          })),
          sampleOnly: true,
        }, null, 2));
      }
      loadedExternIds.push(...batch.map((lead) => lead.externId));
      continue;
    }

    const result = await client.loadLeads(resolved.campaignId, payload);
    loadedExternIds.push(...batch.map((lead) => lead.externId));
    logKv("load response", summarizeResponse(result));
    if (batchDelayMs > 0 && index < batches.length - 1) {
      logKv("next batch wait", `${Math.round(batchDelayMs / 1000)}s`);
      await sleep(batchDelayMs);
    }
  }

  if (live && leadAction) {
    logHeader(`Lead action ${leadAction}`);
    const result = await client.leadAction(leadAction, {
      campaignLeadSearchCriteria: {
        campaignId: resolved.campaignId,
        campaignIds: [resolved.campaignId],
        externIds: loadedExternIds,
      },
    });
    logKv("action response", summarizeResponse(result));
  }

  if (live && watchSec > 0) {
    logHeader("Watching active calls");
    const watch = await watchActiveCalls(client, {
      campaignId: resolved.campaignId,
      dialGroupId: resolved.dialGroupId,
      phones: leads.map((lead) => lead.leadPhone),
      seconds: watchSec,
    });
    logKv("observations", watch.observations);
    logKv("matched active calls", watch.matchedActiveCalls.length);
    for (const row of watch.matchedActiveCalls.slice(0, 10)) {
      logKv(`active ${row.id}`, `firstSeenMs=${row.firstSeenMs} state=${row.state || "(none)"} phone=${row.phone || "(none)"}`);
    }
  }

  if (live && cancelLoaded) {
    logHeader("Cancel loaded leads");
    const result = await client.leadAction("CANCEL_LEADS", {
      campaignLeadSearchCriteria: {
        campaignId: resolved.campaignId,
        campaignIds: [resolved.campaignId],
        externIds: loadedExternIds,
      },
    });
    logKv("cancel response", summarizeResponse(result));
  }

  logHeader("Operator handoff");
  console.log("  1. Agents log into RingCX Agent portal.");
  console.log("  2. Select the predictive dial group/campaign in the CX client.");
  console.log("  3. Confirm softphone/off-hook/connected state.");
  console.log("  4. Set agent state AVAILABLE.");
  console.log("  5. RingCX should pace from the campaign; this script only loads and watches.");

  if (!live) {
    console.log("\nDry-run complete. Re-run with --live when the campaign and list are confirmed.");
  }
}

main().catch((error) => {
  console.error("\nFATAL:", error.message || String(error));
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
