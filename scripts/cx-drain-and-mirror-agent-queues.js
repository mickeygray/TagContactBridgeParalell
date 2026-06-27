#!/usr/bin/env node
"use strict";

// One-off operator reset for the clean CX rails:
//   1. Resolve active CX agents.
//   2. Cancel their traceable RingCX-published queue rows.
//   3. Rebuild/top-up the local morning-style queue.
//   4. Mirror the first N queue rows into RingCX one at a time, in local order.
//
// Dry-run by default. Use --apply only when the floor is ready for the queues
// to be replaced.
//
// Examples:
//   node scripts/cx-drain-and-mirror-agent-queues.js --email mgray@taxadvocategroup.com
//   node scripts/cx-drain-and-mirror-agent-queues.js --email mgray@taxadvocategroup.com --apply
//   node scripts/cx-drain-and-mirror-agent-queues.js --all --limit 30 --apply

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const {
  agentStateRepository,
  cxDialQueueRepository,
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const { buildCxQueueForAgent } = require("../packages/shared-services/src/cxWorkspaceService");
const { publishQueueItemToRingcx } = require("../packages/shared-services/src/ringcxLeadServingService");

const DEFAULT_STATES_TO_MIRROR = Object.freeze(["claimed", "serving", "ready"]);
const DEFAULT_STATES_TO_DRAIN = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);

function parseArgs(argv) {
  const out = {
    apply: false,
    all: false,
    explicitAll: false,
    email: null,
    extensionId: null,
    domain: null,
    companies: ["TAG", "WYNN"],
    limit: 30,
    maxAgents: null,
    build: true,
    drain: true,
    mirror: true,
    reverse: false,
    forcePublish: true,
    respectPresence: false,
    statesToMirror: [...DEFAULT_STATES_TO_MIRROR],
    statesToDrain: [...DEFAULT_STATES_TO_DRAIN],
    paceMs: 0,
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
      case "--apply":
        out.apply = true;
        break;
      case "--all":
        out.all = true;
        out.explicitAll = true;
        break;
      case "--no-build":
        out.build = false;
        break;
      case "--no-drain":
        out.drain = false;
        break;
      case "--no-mirror":
        out.mirror = false;
        break;
      case "--reverse":
        out.reverse = true;
        break;
      case "--reuse-recent":
        out.forcePublish = false;
        break;
      case "--respect-presence":
        out.respectPresence = true;
        break;
      case "--email": {
        const v = readValue(i);
        out.email = String(v.value || "").trim().toLowerCase() || null;
        i += v.consumed;
        break;
      }
      case "--extension-id":
      case "--ext": {
        const v = readValue(i);
        out.extensionId = String(v.value || "").trim() || null;
        i += v.consumed;
        break;
      }
      case "--domain": {
        const v = readValue(i);
        out.domain = String(v.value || "").trim().toUpperCase() || null;
        i += v.consumed;
        break;
      }
      case "--companies": {
        const v = readValue(i);
        const parsed = splitList(v.value).map((entry) => entry.toUpperCase());
        out.companies = parsed.length ? parsed : out.companies;
        i += v.consumed;
        break;
      }
      case "--limit": {
        const v = readValue(i);
        out.limit = Math.max(1, Math.min(Number(v.value) || 30, 250));
        i += v.consumed;
        break;
      }
      case "--max-agents":
      case "--max": {
        const v = readValue(i);
        out.maxAgents = Math.max(1, Number(v.value) || 1);
        i += v.consumed;
        break;
      }
      case "--states": {
        const v = readValue(i);
        const parsed = splitList(v.value);
        out.statesToMirror = parsed.length ? parsed : out.statesToMirror;
        i += v.consumed;
        break;
      }
      case "--drain-states": {
        const v = readValue(i);
        const parsed = splitList(v.value);
        out.statesToDrain = parsed.length ? parsed : out.statesToDrain;
        i += v.consumed;
        break;
      }
      case "--pace-ms":
      case "--pace": {
        const v = readValue(i);
        out.paceMs = Math.max(0, Number(v.value) || 0);
        i += v.consumed;
        break;
      }
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        break;
    }
  }

  if (!out.email && !out.extensionId && !out.all) out.all = true;
  return out;
}

function usage() {
  console.log(`
cx-drain-and-mirror-agent-queues

Dry run, one agent:
  node scripts/cx-drain-and-mirror-agent-queues.js --email agent@taxadvocategroup.com

Apply, one agent:
  node scripts/cx-drain-and-mirror-agent-queues.js --email agent@taxadvocategroup.com --apply

Apply, all active CX-routing agents:
  node scripts/cx-drain-and-mirror-agent-queues.js --all --limit 30 --apply

Flags:
  --apply              perform RingCX cancels and publishes; default is dry-run
  --email EMAIL        limit to one user account
  --extension-id ID    limit to one RingCentral extension id
  --all               process active cxRouting-enabled agents
  --domain WYNN        force queue build/list domain; default is agent company
  --companies TAG,WYNN companies to scan for --all
  --limit N            rows to mirror per agent after build; default 30
  --no-drain           skip RingCX cancel phase
  --no-build           skip local queue top-up phase
  --no-mirror          skip publish phase
  --reverse            publish bottom-to-top instead of local queue order
  --reuse-recent       do not force RingCX reload after drain
  --respect-presence   keep the agent eligibility gate during publish
  --pace-ms N          extra sleep between publish rows
`);
}

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "WYNN";
}

function normalizeExternalId(value) {
  const text = String(value || "").trim();
  return text || null;
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function buildLegacyExternId(item = {}) {
  const domain = normalizeDomain(item.domain || "TAG");
  const caseId = Number(item.caseId || 0) || 0;
  const queueItemId = item._id ? String(item._id) : "";
  if (queueItemId) return `parallel:${domain}:${caseId}:${queueItemId}`;
  return `parallel:${domain}:${caseId}`;
}

function queueItemSummary(item = {}) {
  return {
    id: String(item._id || item.id || ""),
    domain: item.domain || null,
    caseId: item.caseId || null,
    name: item.name || null,
    phone: maskPhone(item.phone),
    state: item.state || null,
    family: item.queueFamily || null,
    assignedExtensionId: item.assignment?.extensionId || null,
    campaignId:
      item.metadata?.rcxVisibilityCampaignId ||
      item.metadata?.lastRingcxPublishedCampaignId ||
      item.rcxCampaignId ||
      null,
    externId:
      item.metadata?.rcxVisibilityExternId ||
      item.metadata?.lastRingcxPublishedExternId ||
      buildLegacyExternId(item),
    visibilityStatus: item.metadata?.rcxVisibilityStatus || null,
  };
}

function policyHasQueue(account = {}) {
  const policy = account.cxQueuePolicy || {};
  if (policy.enabled === false) return false;
  const total = [
    policy.totalOpen,
    policy.fresh?.targetOpen,
    policy.day2to15?.targetOpen,
    policy.day16to30?.targetOpen,
    policy.aged?.targetOpen,
  ].reduce((sum, value) => sum + (Number(value) || 0), 0);
  return total > 0;
}

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  return mongoose.connection.name;
}

async function resolveSingleAgent(options) {
  if (options.email) {
    const account = await userAccountRepository.findUserAccountByEmail(options.email);
    if (!account) throw new Error(`No user account found for ${options.email}`);
    if (!account.extensionId) throw new Error(`User ${options.email} has no extensionId`);
    return [{ account, state: await agentStateRepository.findAgentStateByExtensionId(account.extensionId).catch(() => null) }];
  }
  if (options.extensionId) {
    const account = await userAccountRepository.findUserAccountByExtensionId(options.extensionId);
    if (!account) throw new Error(`No user account found for extension ${options.extensionId}`);
    return [{ account, state: await agentStateRepository.findAgentStateByExtensionId(options.extensionId).catch(() => null) }];
  }
  return null;
}

async function listTargetAgents(options) {
  const single = await resolveSingleAgent(options);
  if (single) return single;

  const byExtension = new Map();
  for (const company of options.companies) {
    const states = await agentStateRepository.listAgentStates({ company, routingEnabled: true });
    for (const state of states) {
      const extensionId = String(state.extensionId || "").trim();
      if (!extensionId || byExtension.has(extensionId)) continue;
      const account = await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null);
      if (!account || account.status !== "active" || !account.extensionId) continue;
      byExtension.set(extensionId, { account, state });
    }
  }

  if (byExtension.size === 0) {
    const accounts = await userAccountRepository.listUserAccounts({ status: "active", audience: "user", limit: 1000 });
    for (const account of accounts) {
      if (!account.extensionId || !policyHasQueue(account)) continue;
      byExtension.set(account.extensionId, {
        account,
        state: await agentStateRepository.findAgentStateByExtensionId(account.extensionId).catch(() => null),
      });
    }
  }

  const agents = Array.from(byExtension.values())
    .sort((a, b) => String(a.account.name || a.account.email).localeCompare(String(b.account.name || b.account.email)));
  return options.maxAgents ? agents.slice(0, options.maxAgents) : agents;
}

function agentDomain(agent, options) {
  return normalizeDomain(options.domain || agent.account.company || agent.state?.company || "WYNN");
}

async function listQueueRowsForAgent(agent, options, states) {
  return cxDialQueueRepository.listQueueItems({
    domain: agentDomain(agent, options),
    states,
    visibleExtensionId: agent.account.extensionId,
    limitAll: true,
  });
}

function collectCancellableRows(rows) {
  return rows
    .map((row) => {
      const summary = queueItemSummary(row);
      return {
        row,
        summary,
        campaignId: normalizeExternalId(summary.campaignId),
        externId: normalizeExternalId(summary.externId),
      };
    })
    .filter((entry) => entry.campaignId && entry.externId);
}

function groupByCampaign(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.campaignId)) groups.set(entry.campaignId, []);
    groups.get(entry.campaignId).push(entry);
  }
  return groups;
}

async function drainRingcxRows(agent, rows, options) {
  const candidates = collectCancellableRows(rows);
  const groups = groupByCampaign(candidates);
  const summary = {
    candidates: candidates.length,
    groups: groups.size,
    cancelled: 0,
    skipped: rows.length - candidates.length,
    errors: [],
  };

  console.log(`  drain candidates: ${candidates.length} traceable / ${rows.length} active rows`);
  for (const [campaignId, entries] of groups.entries()) {
    const externIds = Array.from(new Set(entries.map((entry) => entry.externId).filter(Boolean)));
    console.log(`    ${options.apply ? "CANCEL" : "WOULD cancel"} campaign=${campaignId} externIds=${externIds.length}`);
    if (!options.apply) continue;

    try {
      const client = createRingcxVoiceClient();
      const response = await client.leadAction("CANCEL_LEADS", {
        campaignLeadSearchCriteria: {
          campaignId,
          campaignIds: [campaignId],
          externIds,
        },
      });
      const now = new Date();
      for (const entry of entries) {
        await cxDialQueueRepository.updateQueueItem(String(entry.row._id), {
          "metadata.rcxVisibilityStatus": "stale-cancelled",
          "metadata.rcxVisibilityReason": "cx-drain-and-mirror-agent-queues",
          "metadata.rcxVisibilityCancelledAt": now,
          "metadata.rcxVisibilityCancelResponse": response || null,
          "metadata.rcxVisibilityCancelError": null,
        });
      }
      summary.cancelled += externIds.length;
    } catch (error) {
      summary.errors.push({
        campaignId,
        count: externIds.length,
        error: error.message || String(error),
        status: error.status || null,
      });
      for (const entry of entries) {
        await cxDialQueueRepository.updateQueueItem(String(entry.row._id), {
          "metadata.rcxVisibilityCancelAttemptAt": new Date(),
          "metadata.rcxVisibilityCancelError": {
            message: error.message || String(error),
            status: error.status || null,
            details: error.details || null,
          },
        }).catch(() => null);
      }
    }
  }
  return summary;
}

async function buildLocalQueue(agent, options) {
  const domain = agentDomain(agent, options);
  console.log(`  ${options.apply ? "BUILD" : "WOULD build"} local queue domain=${domain}`);
  if (!options.apply) return { dryRun: true };
  return buildCxQueueForAgent(domain, agent.account.extensionId, {
    previewLimit: options.limit,
    source: "cx-drain-and-mirror-agent-queues",
  });
}

async function mirrorQueueRows(agent, options) {
  let rows = await listQueueRowsForAgent(agent, options, options.statesToMirror);
  rows = rows.slice(0, options.limit);
  if (options.reverse) rows = rows.slice().reverse();
  const summary = {
    attempted: 0,
    published: 0,
    reused: 0,
    skipped: 0,
    deferred: 0,
    errored: 0,
    rows: [],
  };

  console.log(`  mirror rows: ${rows.length} state=${options.statesToMirror.join(",")} priority=NORMAL`);
  for (const row of rows) {
    summary.attempted += 1;
    const base = queueItemSummary(row);
    console.log(`    [${summary.attempted}/${rows.length}] ${options.apply ? "PUBLISH" : "WOULD publish"} ${base.domain} case=${base.caseId} ${base.name || ""} ${base.phone} ${base.state}/${base.family}`);

    if (!options.apply) {
      summary.rows.push({ ...base, dryRun: true });
      continue;
    }

    const startedAt = Date.now();
    const result = await publishQueueItemToRingcx({
      item: row,
      allowedStates: options.statesToMirror,
      force: options.forcePublish,
      respectPresenceGate: options.respectPresence,
      dialPriority: "NORMAL",
    });
    const elapsedMs = Date.now() - startedAt;
    if (result?.published && result?.reused) summary.reused += 1;
    else if (result?.published) summary.published += 1;
    else if (result?.deferred) summary.deferred += 1;
    else if (result?.ok === false) summary.errored += 1;
    else summary.skipped += 1;

    const detail = {
      ...base,
      ok: result?.ok !== false,
      published: Boolean(result?.published),
      reused: Boolean(result?.reused),
      skipped: Boolean(result?.skipped),
      deferred: Boolean(result?.deferred),
      reason: result?.reason || result?.error || null,
      campaignId: result?.campaignId || null,
      externId: result?.externId || null,
      elapsedMs,
    };
    summary.rows.push(detail);
    console.log(`      result ${JSON.stringify(detail)}`);
    if (options.paceMs && summary.attempted < rows.length) await sleep(options.paceMs);
  }
  return summary;
}

async function runForAgent(agent, options) {
  const label = `${agent.account.name || agent.account.email} <${agent.account.email || "no-email"}> ext=${agent.account.extensionId}`;
  console.log(`\n=== ${label} ===`);
  const domain = agentDomain(agent, options);
  console.log(`  domain=${domain} routing=${agent.state?.cxRouting?.enabled === true ? "enabled" : "unknown"} policy=${agent.account.cxQueuePolicy?.tier || "default"}`);

  const result = {
    agent: {
      email: agent.account.email,
      name: agent.account.name,
      extensionId: agent.account.extensionId,
      domain,
    },
    drain: null,
    build: null,
    mirror: null,
  };

  if (options.drain) {
    const drainRows = await listQueueRowsForAgent(agent, options, options.statesToDrain);
    result.drain = await drainRingcxRows(agent, drainRows, options);
  }
  if (options.build) {
    result.build = await buildLocalQueue(agent, options);
  }
  if (options.mirror) {
    result.mirror = await mirrorQueueRows(agent, options);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.apply && !options.email && !options.extensionId && !options.explicitAll) {
    throw new Error("Refusing --apply without an explicit target. Pass --email, --extension-id, or --all.");
  }

  const dbName = await connectMongo();
  const agents = await listTargetAgents(options);
  console.log("CX drain + mirror queue reset");
  console.log(JSON.stringify({
    mode: options.apply ? "APPLY" : "DRY_RUN",
    dbName,
    agents: agents.length,
    email: options.email,
    extensionId: options.extensionId,
    domain: options.domain,
    companies: options.companies,
    limit: options.limit,
    drain: options.drain,
    build: options.build,
    mirror: options.mirror,
    reverse: options.reverse,
    forcePublish: options.forcePublish,
    respectPresence: options.respectPresence,
  }, null, 2));

  const results = [];
  for (const agent of agents) {
    results.push(await runForAgent(agent, options));
  }

  const totals = results.reduce((acc, row) => {
    acc.drainCandidates += Number(row.drain?.candidates || 0);
    acc.cancelled += Number(row.drain?.cancelled || 0);
    acc.publishAttempted += Number(row.mirror?.attempted || 0);
    acc.published += Number(row.mirror?.published || 0);
    acc.reused += Number(row.mirror?.reused || 0);
    acc.deferred += Number(row.mirror?.deferred || 0);
    acc.errored += Number(row.mirror?.errored || 0);
    acc.skipped += Number(row.mirror?.skipped || 0);
    return acc;
  }, {
    drainCandidates: 0,
    cancelled: 0,
    publishAttempted: 0,
    published: 0,
    reused: 0,
    deferred: 0,
    errored: 0,
    skipped: 0,
  });

  console.log("\nSummary:");
  console.log(JSON.stringify({ totals, agents: results.map((row) => ({
    agent: row.agent,
    drain: row.drain && {
      candidates: row.drain.candidates,
      groups: row.drain.groups,
      cancelled: row.drain.cancelled,
      skipped: row.drain.skipped,
      errors: row.drain.errors,
    },
    build: row.build && {
      ok: row.build.ok,
      built: row.build.built,
      before: row.build.before,
      after: row.build.after,
      targetOpen: row.build.targetOpen,
      dryRun: row.build.dryRun,
    },
    mirror: row.mirror && {
      attempted: row.mirror.attempted,
      published: row.mirror.published,
      reused: row.mirror.reused,
      deferred: row.mirror.deferred,
      errored: row.mirror.errored,
      skipped: row.mirror.skipped,
    },
  })) }, null, 2));

  if (!options.apply) {
    console.log("\nDry run only. Re-run with --apply to cancel and mirror RingCX queues.");
  }
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => null);
  });
