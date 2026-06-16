"use strict";

// scripts/cx-morning-prep.js
//
// Runner for the CX morning-prep "6:30am catch-all". DEFAULT IS A READ-ONLY DRY RUN.
//
// WHY: agent FIRST login is slow because the synchronous RingCX off-hook self-heal in
// auth.js funnels every agent's RingCX reads through one GLOBAL serialized 750ms throttle.
// At the login spike that queue backs up into minutes. This runner moves that work OFF-PEAK:
// before logins start it self-heals each active agent (persisting allowOffHook on RingCX) and
// persists the resolved agentGroupId onto the account so login takes the 1-call direct path
// instead of the ~6-call full-group scan. Optionally it prebuilds the first queue pack.
//
// All logic + the non-destructive guarantees live in (and are unit-tested in)
// packages/shared-services/src/cxMorningPrepService.js. This file is only the wiring.
//
//   DRY RUN (default) does ZERO side effects: it reads the roster and reports readiness.
//   --apply runs the self-heal + persist-group phases for eligible agents.
//   --queue (with --apply) additionally prebuilds each agent's first queue pack.
//
// Examples:
//   node scripts/cx-morning-prep.js                          # dry run, default companies, ~4-day recency
//   node scripts/cx-morning-prep.js --apply                  # self-heal + persist group for eligible agents
//   node scripts/cx-morning-prep.js --apply --queue          # also prebuild first queue pack
//   node scripts/cx-morning-prep.js --email mgray@taxadvocategroup.com --apply
//   node scripts/cx-morning-prep.js --all --max 5            # ignore recency filter, cap at 5
//
// Offline self-check (no Mongo, no RingCX): MORNING_PREP_FAKE=1 node scripts/cx-morning-prep.js [--apply]

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createCxMorningPrepService,
  mergeAgentGroupIdIntoMetadata,
  DEFAULT_COMPANIES,
  DEFAULT_RECENT_ACTIVE_MS,
} = require("../packages/shared-services/src/cxMorningPrepService");

const DAY = 24 * 60 * 60 * 1000;

// ── arg parsing (exported for unit testing) ──────────────────────────────────
function parseArgs(argv) {
  const out = {
    apply: false,
    queue: false,
    companies: null,
    recentlyActiveWithinMs: DEFAULT_RECENT_ACTIVE_MS,
    maxAgents: null,
    concurrency: 1,
    paceMs: 0,
    email: null,
    source: null,
    help: false,
  };
  const toks = argv.slice();
  // support both "--flag value" and "--flag=value"
  function nextVal(i) {
    const t = toks[i];
    const eq = t.indexOf("=");
    if (eq >= 0) return { value: t.slice(eq + 1), consumed: 0 };
    return { value: toks[i + 1], consumed: 1 };
  }
  for (let i = 0; i < toks.length; i += 1) {
    const raw = toks[i];
    const flag = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    switch (flag) {
      case "--apply": out.apply = true; break;
      case "--queue": out.queue = true; break;
      case "--all": out.recentlyActiveWithinMs = null; break;
      case "-h":
      case "--help": out.help = true; break;
      case "--companies": { const v = nextVal(i); out.companies = String(v.value || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean); i += v.consumed; break; }
      case "--recent-days": { const v = nextVal(i); out.recentlyActiveWithinMs = Math.max(0, Number(v.value) || 0) * DAY; i += v.consumed; break; }
      case "--max": { const v = nextVal(i); out.maxAgents = Math.max(0, Number(v.value) || 0); i += v.consumed; break; }
      case "--concurrency": { const v = nextVal(i); out.concurrency = Math.max(1, Number(v.value) || 1); i += v.consumed; break; }
      case "--pace": { const v = nextVal(i); out.paceMs = Math.max(0, Number(v.value) || 0); i += v.consumed; break; }
      case "--email": { const v = nextVal(i); out.email = String(v.value || "").trim().toLowerCase() || null; i += v.consumed; break; }
      case "--source": { const v = nextVal(i); out.source = String(v.value || "").trim() || null; i += v.consumed; break; }
      default: break; // ignore unknown tokens (also covers consumed values)
    }
  }
  return out;
}

const USAGE = `cx-morning-prep — off-peak CX agent login prep (DEFAULT: read-only dry run)

  --apply               run side effects (self-heal + persist resolved agentGroupId)
  --queue               also prebuild each agent's first queue pack (requires --apply)
  --companies T,W       companies to include (default: ${DEFAULT_COMPANIES.join(",")})
  --recent-days N       only agents seen within N days (default: ~${Math.round(DEFAULT_RECENT_ACTIVE_MS / DAY)})
  --all                 ignore the recency filter (include every routing-enabled agent)
  --email ADDR          target a single agent by email
  --max N               cap the number of agents processed
  --concurrency N       parallel agents under apply (default 1; keep low — throttle is global)
  --pace N              ms to wait between agents when concurrency=1
  --source LABEL        self-heal source tag (default cx-morning-prep[-dry-run])
  -h, --help            show this help

  Offline self-check: MORNING_PREP_FAKE=1 node scripts/cx-morning-prep.js [--apply]`;

// ── real deps: bind the pure service to the live repositories/services ───────
function buildDefaultMorningPrepDeps({ logger, onlyEmail = null }) {
  const agentStateRepository = require("../packages/shared-repositories/src/agentStateRepository");
  const userAccountRepository = require("../packages/shared-repositories/src/userAccountRepository");
  const { ensureRingcxAgentOffhookAllowed } = require("../packages/shared-services/src/ringcxAgentSelfHealService");
  const { buildCxQueueForAgent } = require("../packages/shared-services/src/cxWorkspaceService");

  async function loadRoster({ companies, routingEnabled }) {
    const rows = [];
    let noAccount = 0;
    for (const company of companies) {
      const states = await agentStateRepository.listAgentStates({ company, routingEnabled });
      for (const st of states) {
        // AgentState carries routing + presence; UserAccount carries identity + metadata
        // (the group lives there) + the id that updateUserAccount needs. Join on extensionId.
        const account = await userAccountRepository.findUserAccountByExtensionId(st.extensionId);
        if (!account) { noAccount += 1; continue; }
        if (onlyEmail && String(account.email || "").toLowerCase() !== onlyEmail) continue;
        const lastSeenAt = st.appPresence && st.appPresence.lastSeenAt
          ? new Date(st.appPresence.lastSeenAt).toISOString()
          : null;
        rows.push({
          email: account.email || st.name || null,
          extensionId: account.extensionId || st.extensionId || null,
          cxAgentId: account.cxAgentId || st.cxAgentId || null,
          company: account.company || st.company || company,
          lastSeenAt,
          metadata: account.metadata || {},
          account, // self-heal + persist operate on the UserAccount record
        });
      }
    }
    if (noAccount && logger && typeof logger.warn === "function") {
      logger.warn("cx.morning_prep.roster_gap", { extensionsWithoutAccount: noAccount });
    }
    return rows;
  }

  async function selfHeal(account, options) {
    return ensureRingcxAgentOffhookAllowed(account, options);
  }

  // Non-destructive: read existing metadata, MERGE in the group, write the full object.
  async function persistAgentGroupId(account, groupId) {
    const metadata = mergeAgentGroupIdIntoMetadata(account.metadata, groupId);
    return userAccountRepository.updateUserAccount(account.id, { metadata });
  }

  async function buildQueue(domain, extensionId, options) {
    return buildCxQueueForAgent(domain, extensionId, options);
  }

  return { loadRoster, selfHeal, persistAgentGroupId, buildQueue, logger };
}

// ── offline fake deps: exercise the whole CLI path with no Mongo / no RingCX ──
function buildFakeMorningPrepDeps({ logger, nowMs }) {
  const roster = [
    // resolvable, no stored group, recently active -> the actionable case (would persist)
    { email: "fresh@example.com", extensionId: "1001", cxAgentId: "cx-1001", company: "TAG",
      lastSeenAt: new Date(nowMs - 1 * DAY).toISOString(), metadata: {}, account: { id: "id-1001", email: "fresh@example.com", cxAgentId: "cx-1001", extensionId: "1001", company: "TAG", metadata: { ringcxRcUserId: "rc-1001" } } },
    // resolvable, group already stored -> self-heal runs but persist is a no-op (idempotent)
    { email: "stored@example.com", extensionId: "1002", cxAgentId: "cx-1002", company: "WYNN",
      lastSeenAt: new Date(nowMs - 2 * DAY).toISOString(), metadata: { ringcxAgentGroupId: "grp-A" }, account: { id: "id-1002", email: "stored@example.com", cxAgentId: "cx-1002", extensionId: "1002", company: "WYNN", metadata: { ringcxAgentGroupId: "grp-A" } } },
    // stale -> excluded by the default recency filter
    { email: "stale@example.com", extensionId: "1003", cxAgentId: "cx-1003", company: "TAG",
      lastSeenAt: new Date(nowMs - 30 * DAY).toISOString(), metadata: {}, account: { id: "id-1003", email: "stale@example.com", cxAgentId: "cx-1003", extensionId: "1003", company: "TAG", metadata: {} } },
  ];
  const writes = [];
  return {
    logger,
    async loadRoster() { return roster; },
    // every agent resolves to grp-A: "stored@" already has it (persist is a no-op), "fresh@" does not (persist fires)
    async selfHeal() { return { ok: true, reason: "already-enabled", patched: false, agentGroupId: "grp-A" }; },
    async persistAgentGroupId(account, groupId) { writes.push({ id: account.id, groupId }); return { ok: true }; },
    async buildQueue(domain, extensionId) { return { ok: true, built: 7, domain, extensionId }; },
    _writes: writes,
  };
}

function makeLogger() {
  return {
    info: (event, meta) => console.log(`  · ${event}`, meta ? JSON.stringify(meta) : ""),
    warn: (event, meta) => console.log(`  ! ${event}`, meta ? JSON.stringify(meta) : ""),
    error: (event, meta) => console.log(`  x ${event}`, meta ? JSON.stringify(meta) : ""),
  };
}

function printSummary(summary) {
  const { apply } = summary;
  console.log(`\n${apply ? "APPLY" : "DRY RUN"}  companies=${summary.companies.join(",")}  recency=${summary.recentlyActiveWithinMs == null ? "off" : Math.round(summary.recentlyActiveWithinMs / DAY) + "d"}  phases=${Object.entries(summary.phases).filter(([, v]) => v).map(([k]) => k).join("+")}`);
  console.log(`roster=${summary.rosterTotal}  eligible=${summary.eligible}  skippedStale=${summary.skippedStale}  processed=${summary.processed}`);

  if (!apply) {
    const t = summary.totals;
    console.log(`identityResolvable=${t.identityResolvable}  groupStored=${t.groupStored}  MISSING-GROUP=${t.missingGroup}  recentlyActive=${t.recentlyActive}`);
    const missing = summary.perAgent.filter((r) => r.identityResolvable && !r.groupStored);
    if (missing.length) {
      console.log(`\nAgents that would get a group persisted on --apply (currently paying the cold full-scan):`);
      for (const r of missing) console.log(`  - ${r.email}  ext=${r.extensionId}  ${r.company}`);
    }
    const unresolvable = summary.perAgent.filter((r) => !r.identityResolvable);
    if (unresolvable.length) {
      console.log(`\nNOT self-healable (missing extensionId or cxAgentId) — skipped by apply:`);
      for (const r of unresolvable) console.log(`  - ${r.email}  ext=${r.extensionId || "?"}  cxAgentId=${r.cxAgentId || "?"}`);
    }
    return;
  }

  const t = summary.totals;
  console.log(`selfHealOk=${t.selfHealOk}  selfHealFailed=${t.selfHealFailed}  groupsResolved=${t.groupsResolved}  groupsPersisted=${t.groupsPersisted}  queuesBuilt=${t.queuesBuilt}  queueItems=${t.queueItemsBuilt}  errors=${t.errors}`);
  const persisted = summary.perAgent.filter((r) => r.groupPersisted);
  if (persisted.length) {
    console.log(`\nGroup persisted (these now take the fast direct path on next login):`);
    for (const r of persisted) console.log(`  - ${r.email}  ext=${r.extensionId}  group=${r.groupResolved}`);
  }
  const errored = summary.perAgent.filter((r) => r.error);
  if (errored.length) {
    console.log(`\nErrors (isolated — did not abort the batch):`);
    for (const r of errored) console.log(`  - ${r.email}  ext=${r.extensionId}  ${r.error}`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return; }

  const logger = makeLogger();
  const fake = process.env.MORNING_PREP_FAKE === "1";

  const runOptions = {
    apply: opts.apply,
    companies: opts.companies || undefined,
    phases: { selfHeal: true, persistGroup: true, queue: opts.queue === true },
    recentlyActiveWithinMs: opts.recentlyActiveWithinMs,
    maxAgents: opts.maxAgents,
    concurrency: opts.concurrency,
    paceMs: opts.paceMs,
    source: opts.source || undefined,
  };

  if (fake) {
    console.log("[MORNING_PREP_FAKE] offline self-check — no Mongo, no RingCX, no writes.");
    const deps = buildFakeMorningPrepDeps({ logger, nowMs: 1_700_000_000_000 });
    const service = createCxMorningPrepService({ ...deps, now: () => 1_700_000_000_000 });
    const summary = await service.runMorningPrep(runOptions);
    printSummary(summary);
    if (opts.apply) console.log(`\n[fake writes] ${JSON.stringify(deps._writes)}`);
    return;
  }

  const mongoose = require("mongoose");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  console.log(`DB connected (${dbName}).`);
  try {
    const deps = buildDefaultMorningPrepDeps({ logger, onlyEmail: opts.email });
    const service = createCxMorningPrepService(deps);
    const summary = await service.runMorningPrep(runOptions);
    printSummary(summary);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error("FATAL", e && e.message ? e.message : e); process.exitCode = 1; });
}

module.exports = { parseArgs, buildDefaultMorningPrepDeps, buildFakeMorningPrepDeps, printSummary, main };
