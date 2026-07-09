"use strict";

// Permanent morning queue builder for the clean CX rails.
//
// Shape:
//   1. Resolve active CX-routing agents.
//   2. Optionally cancel traceable RingCX rows from the prior queue.
//   3. Top up the local queue with the existing queue-builder rules.
//   4. Mirror the first N rows into RingCX one-at-a-time, normal priority.
//
// This intentionally reuses the existing queue generator. The new behavior is
// only the RingCX mirror phase, because bulk/preview rails need RingCX to have
// a ready queue before agents log in.

const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const {
  agentStateRepository,
  cxDialQueueRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const { buildCxQueueForAgent } = require("./cxWorkspaceService");
const { publishQueueItemToRingcx } = require("./ringcxLeadServingService");

const DEFAULT_COMPANIES = Object.freeze(["TAG", "WYNN"]);
const DEFAULT_STATES_TO_MIRROR = Object.freeze(["claimed", "serving", "ready"]);
const DEFAULT_STATES_TO_DRAIN = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "WYNN";
}

function normalizeExternalId(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function normalizePositiveInt(value, fallback, max = 250) {
  const parsed = Math.max(1, Number(value) || fallback);
  return Math.min(parsed, max);
}

function sleep(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!waitMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, waitMs));
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

function normalizeOptions(input = {}) {
  const statesToMirror = Array.isArray(input.statesToMirror)
    ? input.statesToMirror.filter(Boolean)
    : splitList(input.statesToMirror);
  const statesToDrain = Array.isArray(input.statesToDrain)
    ? input.statesToDrain.filter(Boolean)
    : splitList(input.statesToDrain);
  const companies = Array.isArray(input.companies)
    ? input.companies.filter(Boolean)
    : splitList(input.companies);
  const agentEmails = (Array.isArray(input.agentEmails) ? input.agentEmails : splitList(input.agentEmails))
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
  const extensionIds = (Array.isArray(input.extensionIds) ? input.extensionIds : splitList(input.extensionIds))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const hasTargetAllowlist = agentEmails.length > 0 || extensionIds.length > 0;

  return {
    apply: input.apply === true,
    all: !hasTargetAllowlist && (input.all === true || (!input.email && !input.extensionId)),
    confirmAll: input.confirmAll === true,
    email: String(input.email || "").trim().toLowerCase() || null,
    extensionId: String(input.extensionId || "").trim() || null,
    agentEmails,
    extensionIds,
    // The sales queue is WYNN by default even though many UserAccount.company values
    // still read TAG. Operators can override this explicitly when a TAG queue is wanted.
    domain: String(input.domain || "WYNN").trim().toUpperCase() || "WYNN",
    companies: (companies.length ? companies : DEFAULT_COMPANIES).map((entry) => String(entry).toUpperCase()),
    limit: normalizePositiveInt(input.limit, 30, 250),
    maxAgents: input.maxAgents == null ? null : normalizePositiveInt(input.maxAgents, 1, 1000),
    build: input.build !== false,
    drain: input.drain !== false,
    mirror: input.mirror !== false,
    reverse: input.reverse === true,
    forcePublish: input.forcePublish !== false,
    respectPresence: input.respectPresence === true,
    allowBroadDiscovery: input.allowBroadDiscovery === true,
    statesToMirror: statesToMirror.length ? statesToMirror : [...DEFAULT_STATES_TO_MIRROR],
    statesToDrain: statesToDrain.length ? statesToDrain : [...DEFAULT_STATES_TO_DRAIN],
    paceMs: Math.max(0, Number(input.paceMs) || 0),
    source: String(input.source || "cx-morning-queue-builder").trim() || "cx-morning-queue-builder",
    logger: input.logger || null,
  };
}

function summarizeOptions(options) {
  return {
    apply: options.apply,
    email: options.email,
    extensionId: options.extensionId,
    agentEmails: options.agentEmails,
    extensionIds: options.extensionIds,
    all: options.all,
    domain: options.domain,
    companies: options.companies,
    limit: options.limit,
    maxAgents: options.maxAgents,
    build: options.build,
    drain: options.drain,
    mirror: options.mirror,
    reverse: options.reverse,
    forcePublish: options.forcePublish,
    respectPresence: options.respectPresence,
    allowBroadDiscovery: options.allowBroadDiscovery,
    statesToMirror: options.statesToMirror,
    statesToDrain: options.statesToDrain,
    paceMs: options.paceMs,
    source: options.source,
  };
}

function log(logger, level, event, meta) {
  if (logger && typeof logger[level] === "function") {
    logger[level](event, meta);
  }
}

async function resolveSingleAgent(options) {
  if (options.email) {
    const account = await userAccountRepository.findUserAccountByEmail(options.email);
    if (!account) throw new Error(`No user account found for ${options.email}`);
    if (!account.extensionId) throw new Error(`User ${options.email} has no extensionId`);
    return [{
      account,
      state: await agentStateRepository.findAgentStateByExtensionId(account.extensionId).catch(() => null),
    }];
  }
  if (options.extensionId) {
    const account = await userAccountRepository.findUserAccountByExtensionId(options.extensionId);
    if (!account) throw new Error(`No user account found for extension ${options.extensionId}`);
    return [{
      account,
      state: await agentStateRepository.findAgentStateByExtensionId(options.extensionId).catch(() => null),
    }];
  }
  return null;
}

function filterTargetAgentsByAllowlist(agents = [], options = {}) {
  const emailAllowlist = new Set((options.agentEmails || []).map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean));
  const extensionAllowlist = new Set((options.extensionIds || []).map((entry) => String(entry || "").trim()).filter(Boolean));
  if (emailAllowlist.size === 0 && extensionAllowlist.size === 0) return agents;

  return agents.filter(({ account = {} }) => {
    const email = String(account.email || "").trim().toLowerCase();
    const extensionId = String(account.extensionId || "").trim();
    return (email && emailAllowlist.has(email)) || (extensionId && extensionAllowlist.has(extensionId));
  });
}

function hasTargetAllowlist(options = {}) {
  return (options.agentEmails || []).length > 0 || (options.extensionIds || []).length > 0;
}

async function listTargetAgents(options) {
  const single = await resolveSingleAgent(options);
  if (single) return single;

  if (!hasTargetAllowlist(options) && options.allowBroadDiscovery !== true) {
    log(options.logger, "warn", "cx.morning_queue_builder.no_explicit_targets", {
      reason: "broad-discovery-disabled",
      source: options.source,
    });
    return [];
  }

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
    const accounts = await userAccountRepository.listUserAccounts({
      status: "active",
      audience: "user",
      limit: 1000,
    });
    for (const account of accounts) {
      if (!account.extensionId || !policyHasQueue(account)) continue;
      byExtension.set(account.extensionId, {
        account,
        state: await agentStateRepository.findAgentStateByExtensionId(account.extensionId).catch(() => null),
      });
    }
  }

  const agents = filterTargetAgentsByAllowlist(Array.from(byExtension.values()), options)
    .sort((left, right) => String(left.account.name || left.account.email)
      .localeCompare(String(right.account.name || right.account.email)));
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

  log(options.logger, "info", "cx.morning_queue_builder.drain_started", {
    email: agent.account.email || null,
    extensionId: agent.account.extensionId || null,
    candidates: candidates.length,
    rows: rows.length,
    apply: options.apply,
  });

  for (const [campaignId, entries] of groups.entries()) {
    const externIds = Array.from(new Set(entries.map((entry) => entry.externId).filter(Boolean)));
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
          "metadata.rcxVisibilityReason": options.source,
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
  if (!options.apply) return { dryRun: true };
  return buildCxQueueForAgent(agentDomain(agent, options), agent.account.extensionId, {
    previewLimit: options.limit,
    source: options.source,
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

  for (const row of rows) {
    summary.attempted += 1;
    const base = queueItemSummary(row);

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

    summary.rows.push({
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
    });

    if (options.paceMs && summary.attempted < rows.length) await sleep(options.paceMs);
  }

  return summary;
}

async function runForAgent(agent, options) {
  const domain = agentDomain(agent, options);
  const startedAt = Date.now();
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
    elapsedMs: 0,
    error: null,
  };

  try {
    log(options.logger, "info", "cx.morning_queue_builder.agent_started", {
      email: result.agent.email,
      extensionId: result.agent.extensionId,
      domain,
      apply: options.apply,
    });

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
  } catch (error) {
    result.error = error.message || String(error);
    log(options.logger, "warn", "cx.morning_queue_builder.agent_failed", {
      email: result.agent.email,
      extensionId: result.agent.extensionId,
      error: result.error,
    });
  } finally {
    result.elapsedMs = Date.now() - startedAt;
  }

  return result;
}

function summarizeResults(results) {
  return results.reduce((acc, row) => {
    acc.agents += 1;
    if (row.error) acc.agentErrors += 1;
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
    agents: 0,
    agentErrors: 0,
    drainCandidates: 0,
    cancelled: 0,
    publishAttempted: 0,
    published: 0,
    reused: 0,
    deferred: 0,
    errored: 0,
    skipped: 0,
  });
}

async function runCxMorningQueueBuilder(input = {}) {
  const options = normalizeOptions(input);
  if (options.apply && options.all && !options.email && !options.extensionId && !options.confirmAll) {
    throw new Error("Refusing to apply all-agent morning queue builder without confirmAll=true.");
  }

  const startedAt = new Date();
  const agents = await listTargetAgents(options);
  const results = [];

  log(options.logger, "info", "cx.morning_queue_builder.started", {
    ...summarizeOptions(options),
    agents: agents.length,
  });

  for (const agent of agents) {
    results.push(await runForAgent(agent, options));
  }

  const summary = {
    ok: results.every((row) => !row.error),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    options: summarizeOptions(options),
    totals: summarizeResults(results),
    agents: results,
  };

  log(options.logger, summary.ok ? "info" : "warn", "cx.morning_queue_builder.completed", {
    ok: summary.ok,
    totals: summary.totals,
  });

  return summary;
}

function readCxMorningQueueBuilderOptionsFromEnv(env = process.env, logger = null) {
  const agentEmails = splitList(env.CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS);
  const extensionIds = splitList(env.CX_MORNING_QUEUE_BUILDER_EXTENSION_IDS);

  return {
    apply: true,
    all: agentEmails.length === 0 && extensionIds.length === 0,
    confirmAll: true,
    logger,
    source: "cx-morning-queue-builder-7am",
    agentEmails,
    extensionIds,
    domain: String(env.CX_MORNING_QUEUE_BUILDER_DOMAIN || "WYNN").trim().toUpperCase() || "WYNN",
    companies: splitList(env.CX_MORNING_QUEUE_BUILDER_COMPANIES || "TAG,WYNN"),
    limit: normalizePositiveInt(env.CX_MORNING_QUEUE_BUILDER_LIMIT, 30, 250),
    maxAgents: env.CX_MORNING_QUEUE_BUILDER_MAX_AGENTS
      ? normalizePositiveInt(env.CX_MORNING_QUEUE_BUILDER_MAX_AGENTS, 1, 1000)
      : null,
    build: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_BUILD, true),
    drain: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_DRAIN, true),
    // M5/FM-2b: the UCQ mirror is OFF by default now, and force-disabled whenever pacing is on —
    // mirroring CxDialQueue rows into the UCQ while the rails reserve those same rows is the
    // cross-pool double-dial bridge. (options.mirror at the call site reads this gated value.)
    mirror: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_MIRROR, false)
      && !["1", "true", "yes", "on"].includes(String(env.PACING_QUEUE_ENABLED || "").trim().toLowerCase()),
    reverse: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_REVERSE, false),
    forcePublish: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_FORCE_PUBLISH, true),
    respectPresence: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_RESPECT_PRESENCE, false),
    allowBroadDiscovery: normalizeBoolean(env.CX_MORNING_QUEUE_BUILDER_ALLOW_BROAD_DISCOVERY, false),
    paceMs: Math.max(0, Number(env.CX_MORNING_QUEUE_BUILDER_PACE_MS) || 0),
  };
}

function isCxMorningQueueBuilderEnabled(env = process.env) {
  const explicit = env.CX_MORNING_QUEUE_BUILDER_ENABLED;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return normalizeBoolean(explicit, false);
  }
  return normalizeBoolean(env.CX_DIAL_RUNTIME_BULK_LOAD_ENABLED, false);
}

module.exports = {
  DEFAULT_COMPANIES,
  DEFAULT_STATES_TO_DRAIN,
  DEFAULT_STATES_TO_MIRROR,
  agentDomain,
  filterTargetAgentsByAllowlist,
  hasTargetAllowlist,
  isCxMorningQueueBuilderEnabled,
  normalizeOptions,
  readCxMorningQueueBuilderOptionsFromEnv,
  runCxMorningQueueBuilder,
};
