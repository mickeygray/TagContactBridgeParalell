"use strict";

// CX morning-prep service (the "6:30am catch-all").
//
// WHY: agent FIRST login is slow because the synchronous RingCX off-hook self-heal
// (apps/control-plane/src/routes/auth.js) funnels every agent's RingCX reads through a
// single GLOBAL serialized throttle (ringcxVoiceClient withApiThrottle, 750ms/call). At
// the 7am login spike that queue backs up into minutes. This service moves that work
// OFF-PEAK: before logins start, for each active agent we (1) run the idempotent
// self-heal so allowOffHook is persisted on RingCX, (2) persist the resolved agentGroupId
// back onto the account so login's self-heal takes the 1-call direct path instead of the
// ~6-call full-group scan, and optionally (3) prebuild the agent's first queue pack.
//
// DESIGN: this module is PURE ORCHESTRATION over injected seams so it unit-tests without
// Mongo or RingCX. The real wiring lives in buildDefaultMorningPrepDeps(); tests pass fakes.
//
// NON-DESTRUCTIVE GUARANTEES (enforced + tested):
//  - dry-run (apply:false) performs ZERO side effects: no self-heal call, no DB write, no
//    queue mutation. It only reads the roster and reports per-agent readiness.
//  - persistAgentGroupId MERGES into existing metadata (never clobbers) and only writes
//    when the resolved group actually differs from what's stored (idempotent).
//  - the queue phase is OFF by default; it must be opted into explicitly.
//  - presence/activity is never touched here (agents are not marked active before login).
//  - a failure on one agent is isolated and never aborts the batch.

const DEFAULT_COMPANIES = Object.freeze(["TAG", "WYNN"]);
const DEFAULT_RECENT_ACTIVE_MS = 4 * 24 * 60 * 60 * 1000; // ~4 days; null disables the filter

// Pure helper: merge the resolved agentGroupId into an account's existing metadata WITHOUT
// clobbering other keys. updateUserAccount treats `metadata` as a whole-object editable
// field, so we must hand it the full merged object. Exported for direct unit testing.
function mergeAgentGroupIdIntoMetadata(existingMetadata, groupId) {
  const base = existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {};
  return { ...base, ringcxAgentGroupId: String(groupId || "").trim() || base.ringcxAgentGroupId || null };
}

function normalizePhases(phases) {
  const p = phases && typeof phases === "object" ? phases : {};
  return {
    selfHeal: p.selfHeal !== false, // default ON
    persistGroup: p.persistGroup !== false, // default ON
    queue: p.queue === true, // default OFF — opt in explicitly
  };
}

function isRecentlyActive(agent, nowMs, windowMs) {
  if (!windowMs || windowMs <= 0) return true; // filter disabled
  const seen = agent.lastSeenAt ? Date.parse(agent.lastSeenAt) : NaN;
  if (!Number.isFinite(seen)) return false; // never-seen agents are excluded when the filter is on
  return nowMs - seen <= windowMs;
}

function identityResolvable(agent) {
  // The self-heal needs an extensionId plus an agent identity (cxAgentId is the primary key
  // the direct RingCX getAgent uses). Without these it cannot find the RingCX agent at all.
  return Boolean(String(agent.extensionId || "").trim()) && Boolean(String(agent.cxAgentId || "").trim());
}

function hasStoredGroup(agent) {
  const md = agent.metadata || (agent.account && agent.account.metadata) || {};
  return Boolean(String(md.ringcxAgentGroupId || "").trim());
}

async function mapWithConcurrency(items, limit, fn) {
  const lim = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(lim, items.length) }, () => worker()));
  return results;
}

function createCxMorningPrepService(deps = {}) {
  const {
    loadRoster, // async ({ companies, routingEnabled }) => agent[] enriched with account/metadata/lastSeenAt
    selfHeal, // async (account, { source }) => { ok, reason, patched, agentGroupId }
    persistAgentGroupId, // async (account, groupId) => { ok }   (real impl does the merge-write)
    buildQueue, // async (domain, extensionId, options) => { ok, before, after, built }
    now = () => Date.now(),
    logger = null,
    emit = null, // optional (eventName, payload) => void  for a summary event
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;

  if (typeof loadRoster !== "function") throw new Error("cxMorningPrep: loadRoster dep is required");

  function log(level, event, meta) {
    if (logger && typeof logger[level] === "function") logger[level](event, meta);
  }

  function assessAgent(agent, nowMs, windowMs) {
    return {
      email: agent.email || null,
      extensionId: agent.extensionId || null,
      cxAgentId: agent.cxAgentId || null,
      company: agent.company || null,
      recentlyActive: isRecentlyActive(agent, nowMs, windowMs),
      identityResolvable: identityResolvable(agent),
      groupStored: hasStoredGroup(agent),
    };
  }

  async function prepAgent(agent, phases, source) {
    const account = agent.account || agent;
    const domain = agent.company || account.company || "TAG";
    const row = {
      email: agent.email || account.email || null,
      extensionId: agent.extensionId || account.extensionId || null,
      company: domain,
      selfHeal: null,
      groupResolved: null,
      groupPersisted: false,
      queueBuilt: null,
      error: null,
    };
    try {
      let resolvedGroup = null;
      if (phases.selfHeal && typeof selfHeal === "function") {
        const heal = await selfHeal(account, { source });
        row.selfHeal = { ok: Boolean(heal && heal.ok), reason: heal && heal.reason, patched: Boolean(heal && heal.patched) };
        resolvedGroup = heal && heal.agentGroupId ? String(heal.agentGroupId).trim() : null;
        row.groupResolved = resolvedGroup;
      }

      if (phases.persistGroup && resolvedGroup && typeof persistAgentGroupId === "function") {
        const currentStored = String((account.metadata && account.metadata.ringcxAgentGroupId) || "").trim();
        if (resolvedGroup !== currentStored) {
          await persistAgentGroupId(account, resolvedGroup); // idempotent: only when changed
          row.groupPersisted = true;
        }
      }

      if (phases.queue && typeof buildQueue === "function") {
        const q = await buildQueue(domain, row.extensionId, { source });
        row.queueBuilt = q && typeof q.built === "number" ? q.built : (q && q.ok ? 0 : null);
      }
    } catch (error) {
      row.error = error && error.message ? error.message : String(error);
      log("warn", "cx.morning_prep.agent_failed", { email: row.email, extensionId: row.extensionId, error: row.error });
    }
    return row;
  }

  // The single entry point. Default is a read-only dry run.
  async function runMorningPrep(options = {}) {
    const apply = options.apply === true;
    const companies = Array.isArray(options.companies) && options.companies.length ? options.companies : DEFAULT_COMPANIES;
    const phases = normalizePhases(options.phases);
    const windowMs = options.recentlyActiveWithinMs === null
      ? null
      : Math.max(0, Number(options.recentlyActiveWithinMs ?? DEFAULT_RECENT_ACTIVE_MS) || 0);
    const maxAgents = options.maxAgents == null ? null : Math.max(0, Number(options.maxAgents) || 0);
    const concurrency = Math.max(1, Number(options.concurrency) || 1);
    const paceMs = Math.max(0, Number(options.paceMs) || 0);
    const source = options.source || (apply ? "cx-morning-prep" : "cx-morning-prep-dry-run");

    const nowMs = now();
    const startedAt = new Date(nowMs).toISOString();

    const roster = (await loadRoster({ companies, routingEnabled: true })) || [];

    const eligible = roster.filter((a) => isRecentlyActive(a, nowMs, windowMs));
    const skippedStale = roster.length - eligible.length;
    const capped = maxAgents == null ? eligible : eligible.slice(0, maxAgents);

    const baseSummary = {
      apply,
      source,
      companies,
      phases,
      recentlyActiveWithinMs: windowMs,
      startedAt,
      rosterTotal: roster.length,
      eligible: eligible.length,
      skippedStale,
      processed: 0,
    };

    if (!apply) {
      // DRY RUN: read-only assessment. No self-heal, no writes, no queue mutation.
      const perAgent = capped.map((a) => assessAgent(a, nowMs, windowMs));
      const summary = {
        ...baseSummary,
        processed: perAgent.length,
        perAgent,
        totals: {
          identityResolvable: perAgent.filter((r) => r.identityResolvable).length,
          groupStored: perAgent.filter((r) => r.groupStored).length,
          // the population currently paying the slow full-group scan on cold login:
          missingGroup: perAgent.filter((r) => r.identityResolvable && !r.groupStored).length,
          recentlyActive: perAgent.filter((r) => r.recentlyActive).length,
        },
        finishedAt: new Date(now()).toISOString(),
      };
      if (emit) emit("cx.morning_prep.dry_run", summary);
      log("info", "cx.morning_prep.dry_run", { eligible: summary.eligible, missingGroup: summary.totals.missingGroup });
      return summary;
    }

    // APPLY: run the enabled phases per eligible agent, isolated, bounded concurrency.
    const perAgent = await mapWithConcurrency(capped, concurrency, async (agent, index) => {
      if (paceMs && index > 0 && concurrency === 1) await sleep(paceMs);
      return prepAgent(agent, phases, source);
    });

    const summary = {
      ...baseSummary,
      processed: perAgent.length,
      perAgent,
      totals: {
        selfHealOk: perAgent.filter((r) => r.selfHeal && r.selfHeal.ok).length,
        selfHealFailed: perAgent.filter((r) => r.selfHeal && !r.selfHeal.ok).length,
        groupsResolved: perAgent.filter((r) => r.groupResolved).length,
        groupsPersisted: perAgent.filter((r) => r.groupPersisted).length,
        queuesBuilt: perAgent.filter((r) => typeof r.queueBuilt === "number").length,
        queueItemsBuilt: perAgent.reduce((sum, r) => sum + (typeof r.queueBuilt === "number" ? r.queueBuilt : 0), 0),
        errors: perAgent.filter((r) => r.error).length,
      },
      finishedAt: new Date(now()).toISOString(),
    };
    if (emit) emit("cx.morning_prep.apply", summary);
    log("info", "cx.morning_prep.apply", {
      processed: summary.processed,
      groupsPersisted: summary.totals.groupsPersisted,
      errors: summary.totals.errors,
    });
    return summary;
  }

  return { runMorningPrep };
}

module.exports = {
  createCxMorningPrepService,
  mergeAgentGroupIdIntoMetadata,
  isRecentlyActive,
  identityResolvable,
  hasStoredGroup,
  DEFAULT_COMPANIES,
  DEFAULT_RECENT_ACTIVE_MS,
};
