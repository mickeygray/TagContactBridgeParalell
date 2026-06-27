#!/usr/bin/env node
"use strict";

// Read-only prep for a real-agent bulk-load test.
//
// This script intentionally has no --apply path. It does not drain RingCX, publish
// leads, reserve rows, or mutate Mongo. It answers: "if Sean starts bulk_load with
// target N, what route/config will be used, what ready rows are available, and
// what should we watch in logs?"

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue } = require("../packages/shared-models/src");
const {
  cxBulkLoadSessionRepository,
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const { buildFamilyTargets } = require("../packages/shared-services/src/cxReserveModeService");
const {
  isCxBulkLoadRuntime,
  resolveCxDialRuntimeMode,
} = require("../packages/shared-services/src/cxDialRuntimeModeService");

const DEFAULT_AGENT_EMAIL = "slucas@taxadvocategroup.com";
const DEFAULT_DOMAIN = "WYNN";
const DEFAULT_TARGET = 10;
const DEFAULT_REFILL_PREVIEW = 30;

const QUEUE_SORT = Object.freeze({
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  priorityScore: -1,
  releaseAt: 1,
  createdAt: 1,
  _id: 1,
});

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeEmail(value) {
  return str(value).toLowerCase();
}

function normalizeDomain(value) {
  return str(value).toUpperCase() || DEFAULT_DOMAIN;
}

function normalizeExternalId(value) {
  return str(value) || null;
}

function envToken(value) {
  const token = str(value);
  if (!token) return null;
  const normalized = token
    .replace(/@/g, "_AT_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || null;
}

function readEnv(name, fallback = "") {
  const value = process.env[name];
  return value != null && value !== "" ? String(value) : fallback;
}

function splitList(value) {
  return str(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    email: DEFAULT_AGENT_EMAIL,
    extensionId: null,
    domain: DEFAULT_DOMAIN,
    target: DEFAULT_TARGET,
    refillPreview: DEFAULT_REFILL_PREVIEW,
    includeActiveSessions: true,
    help: false,
  };

  function readValue(index) {
    const raw = argv[index] || "";
    const eq = raw.indexOf("=");
    if (eq >= 0) return { value: raw.slice(eq + 1), consumed: 0 };
    return { value: argv[index + 1], consumed: 1 };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const flag = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    switch (flag) {
      case "--email": {
        const v = readValue(i);
        out.email = normalizeEmail(v.value) || DEFAULT_AGENT_EMAIL;
        i += v.consumed;
        break;
      }
      case "--extension-id":
      case "--ext": {
        const v = readValue(i);
        out.extensionId = normalizeExternalId(v.value);
        i += v.consumed;
        break;
      }
      case "--domain": {
        const v = readValue(i);
        out.domain = normalizeDomain(v.value);
        i += v.consumed;
        break;
      }
      case "--target": {
        const v = readValue(i);
        out.target = Math.max(1, Math.min(Number(v.value) || DEFAULT_TARGET, 100));
        i += v.consumed;
        break;
      }
      case "--refill-preview":
      case "--refill": {
        const v = readValue(i);
        out.refillPreview = Math.max(0, Math.min(Number(v.value) || DEFAULT_REFILL_PREVIEW, 250));
        i += v.consumed;
        break;
      }
      case "--no-active-sessions":
        out.includeActiveSessions = false;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function usage() {
  console.log(`
cx-bulk-agent-test-prep

Read-only prep for a bulk_load real-agent test. No RingCX or Mongo writes.

Default Sean/WYNN test:
  node scripts/cx-bulk-agent-test-prep.js

Explicit:
  node scripts/cx-bulk-agent-test-prep.js --email slucas@taxadvocategroup.com --domain WYNN --target 10 --refill-preview 30

Flags:
  --email EMAIL          agent email, default ${DEFAULT_AGENT_EMAIL}
  --extension-id ID      resolve by extension instead of email
  --domain WYNN          queue domain, default ${DEFAULT_DOMAIN}
  --target N            initial target buffer preview, default ${DEFAULT_TARGET}
  --refill-preview N    extra ready rows to preview behind target, default ${DEFAULT_REFILL_PREVIEW}
`);
}

function maskPhone(value) {
  const digits = str(value).replace(/\D/g, "");
  if (!digits) return null;
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function summarizeQueueItem(row) {
  return {
    id: str(row?._id),
    caseId: row?.caseId || null,
    name: row?.name || null,
    phone: maskPhone(row?.phone),
    domain: row?.domain || null,
    state: row?.state || null,
    queueFamily: row?.queueFamily || null,
    queueFamilyRank: row?.queueFamilyRank ?? null,
    dailyPlacedCalls: row?.dailyPlacedCalls ?? null,
    progressiveStageIndex: row?.progressiveStageIndex ?? null,
    rcxCampaignId: row?.rcxCampaignId || null,
    rcxDialGroupId: row?.rcxDialGroupId || null,
    assignedExtensionId: row?.assignment?.extensionId || null,
    releaseAt: row?.releaseAt || null,
  };
}

function resolveBulkAgentRingcxRoute(agent = {}, input = {}) {
  const account = agent.account || {};
  const tokens = [
    input.agentExtensionId,
    input.extensionId,
    agent.agentExtensionId,
    input.cxAgentId,
    input.ringcxAgentId,
    agent.cxAgentId,
    input.agentEmail,
    agent.agentEmail,
    account.email,
    account.name,
  ];
  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const dialGroupId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`));
    const campaignId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`));
    if (dialGroupId || campaignId) {
      return { dialGroupId, campaignId, matchedToken: String(token) };
    }
  }
  return { dialGroupId: null, campaignId: null, matchedToken: null };
}

async function resolveAgent(args) {
  const account = args.extensionId
    ? await userAccountRepository.findUserAccountByExtensionId(args.extensionId)
    : await userAccountRepository.findUserAccountByEmail(args.email);
  if (!account) {
    throw new Error(`Could not resolve agent (${args.extensionId || args.email})`);
  }
  return {
    account,
    agentEmail: normalizeEmail(account.email || args.email),
    agentExtensionId: normalizeExternalId(args.extensionId || account.extensionId),
    cxAgentId: normalizeExternalId(account.cxAgentId || account.ringcxAgentId),
    ringcxAgentGroupId: normalizeExternalId(
      account.metadata?.ringcxAgentGroupId ||
        account.metadata?.cxAgentGroupId ||
        readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID"),
    ),
  };
}

function buildRoute(agent, args) {
  const agentRoute = resolveBulkAgentRingcxRoute(agent, {
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
    cxAgentId: agent.cxAgentId,
  });
  return {
    accountId: normalizeExternalId(readEnv("RINGCX_VOICE_ACCOUNT_ID")),
    campaignId: agentRoute.campaignId || normalizeExternalId(readEnv("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID")),
    dialGroupId: agentRoute.dialGroupId || normalizeExternalId(readEnv("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID")),
    agentGroupId: agent.ringcxAgentGroupId || normalizeExternalId(readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID")),
    dialPriority: "NORMAL",
    agentRoute,
    domain: args.domain,
  };
}

function readyQuery({ domain, route, queueFamily, excludeIds = [] }) {
  const query = {
    domain,
    state: "ready",
    queueFamily,
    "metadata.appointmentId": { $in: [null, ""] },
  };
  if (route.accountId) query.rcxAccountId = route.accountId;
  if (route.campaignId) query.rcxCampaignId = route.campaignId;
  if (route.dialGroupId) query.rcxDialGroupId = route.dialGroupId;
  const excluded = excludeIds.map(str).filter(Boolean);
  if (excluded.length) query._id = { $nin: excluded };
  return query;
}

async function previewRowsByTargets({ domain, route, familyTargets, totalLimit, excludeIds = [] }) {
  const selected = [];
  const short = {};
  let remaining = Math.max(Number(totalLimit) || 0, 0);
  const takenIds = new Set(excludeIds.map(str).filter(Boolean));

  for (const [family, rawCount] of Object.entries(familyTargets || {})) {
    if (remaining <= 0) break;
    const want = Math.min(Math.max(Number(rawCount) || 0, 0), remaining);
    if (!want) continue;
    const rows = await CxDialQueue.find(readyQuery({
      domain,
      route,
      queueFamily: family,
      excludeIds: Array.from(takenIds),
    }))
      .sort({ ...QUEUE_SORT })
      .limit(want)
      .lean();
    for (const row of rows) {
      selected.push(row);
      takenIds.add(str(row._id));
    }
    if (rows.length < want) short[family] = want - rows.length;
    remaining -= rows.length;
  }
  return { rows: selected, short };
}

async function countReadyByFamily({ domain, route, familyTargets }) {
  const out = {};
  for (const family of Object.keys(familyTargets || {})) {
    out[family] = await CxDialQueue.countDocuments(readyQuery({ domain, route, queueFamily: family }));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const config = getSharedConfig();
  const mongo = await connectMongo(config);
  if (!mongo.connected) throw new Error("Mongo connection was not established");

  const agent = await resolveAgent(args);
  const route = buildRoute(agent, args);
  const runtime = resolveCxDialRuntimeMode({
    userEmail: agent.agentEmail,
    extensionId: agent.agentExtensionId,
  });
  const familyTargets = buildFamilyTargets({
    policy: agent.account,
    totalDeficit: args.target,
    env: process.env,
  });
  const startPreview = await previewRowsByTargets({
    domain: args.domain,
    route,
    familyTargets,
    totalLimit: args.target,
  });
  const refillPreview = await previewRowsByTargets({
    domain: args.domain,
    route,
    familyTargets,
    totalLimit: args.refillPreview,
    excludeIds: startPreview.rows.map((row) => row._id),
  });
  const readyCounts = await countReadyByFamily({ domain: args.domain, route, familyTargets });
  const activeSessions = args.includeActiveSessions
    ? await cxBulkLoadSessionRepository.findActiveBulkLoadSessionsForAgent({
        agentEmail: agent.agentEmail,
        agentExtensionId: agent.agentExtensionId,
      }).catch(() => [])
    : [];

  const warnings = [];
  if (!isCxBulkLoadRuntime(runtime)) warnings.push(`bulk_load is not active for ${agent.agentEmail}: ${runtime.reason}`);
  if (!route.accountId) warnings.push("missing RINGCX_VOICE_ACCOUNT_ID");
  if (!route.campaignId) warnings.push("missing campaignId route");
  if (!route.dialGroupId) warnings.push("missing dialGroupId route");
  if (!route.agentGroupId) warnings.push("missing agentGroupId route");
  if (startPreview.rows.length < args.target) warnings.push(`only ${startPreview.rows.length}/${args.target} start rows available`);
  if (refillPreview.rows.length < args.refillPreview) warnings.push(`only ${refillPreview.rows.length}/${args.refillPreview} refill-preview rows available`);
  if (activeSessions.length) warnings.push(`${activeSessions.length} active bulk session(s) exist for this agent; test start will retire/replace them`);

  const report = {
    dryRun: true,
    writes: "none",
    ringcxCalls: "none",
    agent: {
      email: agent.agentEmail,
      extensionId: agent.agentExtensionId,
      cxAgentId: agent.cxAgentId,
      name: agent.account?.name || null,
      company: agent.account?.company || null,
    },
    runtime,
    route,
    testShape: {
      domain: args.domain,
      target: args.target,
      refillThreshold: 5,
      refillPreview: args.refillPreview,
      dialPriority: "NORMAL",
      flowTraceEnv: {
        CX_BULK_LOAD_FLOW_TRACE: "true",
        CX_BULK_LOAD_FLOW_TRACE_AGENT: agent.agentEmail,
        CX_BULK_LOAD_DISPOSITION_TRACE: "true",
      },
    },
    familyTargets,
    readyCounts,
    startPreview: {
      count: startPreview.rows.length,
      short: startPreview.short,
      rows: startPreview.rows.map(summarizeQueueItem),
    },
    refillPreview: {
      count: refillPreview.rows.length,
      short: refillPreview.short,
      rows: refillPreview.rows.map(summarizeQueueItem),
    },
    activeSessions: activeSessions.map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      phase: session.phase,
      currentCaseId: session.current?.caseId || null,
      bufferCount: Array.isArray(session.acceptedBuffer) ? session.acceptedBuffer.length : 0,
      updatedAt: session.updatedAt || null,
    })),
    warnings,
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo().catch(() => null);
  });
