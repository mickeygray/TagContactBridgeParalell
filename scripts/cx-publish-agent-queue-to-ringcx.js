#!/usr/bin/env node
"use strict";

// One-off local runner: mirror an agent's CX queue rows into RingCX.
//
// Dry-run by default. This is intentionally agent-scoped because pushing a whole
// shared queue into RingCX is an easy way to create a very loud day.
//
// Examples:
//   node scripts/cx-publish-agent-queue-to-ringcx.js --email sean@taxadvocategroup.com
//   node scripts/cx-publish-agent-queue-to-ringcx.js --extension-id 63756126004 --states claimed,serving --apply
//   node scripts/cx-publish-agent-queue-to-ringcx.js --email brad@taxadvocategroup.com --states queued,ready,claimed,serving --limit 10 --apply
//
// Flags:
//   --apply                 Actually calls RingCX loadLeads + stamps queue metadata.
//   --email EMAIL           Resolve agent by user account email.
//   --extension-id ID       Resolve agent by RingCentral extension id.
//   --domain WYNN           Optional queue filter.
//   --states LIST           Default: claimed,serving.
//   --families LIST         Optional queueFamily filter.
//   --limit N               Default: 50. Use --limit all for every matching row.
//   --force                 Bypass the "recently published" reuse guard.
//   --respect-presence      Keep publishQueueItemToRingcx's agent eligibility gate.
//   --pace-ms N             Sleep between apply publishes. Default: 350ms.
//   --dial-priority VALUE   RingCX lead loader priority. Default: NORMAL.
//   --reverse               Publish the selected rows bottom-to-top.
//   --manual-test-tag TAG   Restrict to rows with metadata.manualDialTest.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const {
  cxDialQueueRepository,
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const {
  publishQueueItemToRingcx,
} = require("../packages/shared-services/src/ringcxLeadServingService");

const DEFAULT_STATES = ["claimed", "serving"];
const ACTIVE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

function parseArgs(argv) {
  const out = {
    apply: false,
    email: null,
    extensionId: null,
    domain: null,
    states: DEFAULT_STATES,
    families: [],
    limit: 50,
    force: false,
    respectPresence: false,
    includeUnassignedVisible: false,
    reverse: false,
    manualTestTag: null,
    paceMs: 350,
    dialPriority: "NORMAL",
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
      case "--force":
        out.force = true;
        break;
      case "--respect-presence":
        out.respectPresence = true;
        break;
      case "--include-unassigned-visible":
        out.includeUnassignedVisible = true;
        break;
      case "--reverse":
        out.reverse = true;
        break;
      case "--manual-test-tag": {
        const v = readValue(i);
        out.manualTestTag = String(v.value || "").trim() || null;
        i += v.consumed;
        break;
      }
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
      case "--states": {
        const v = readValue(i);
        const normalized = splitList(v.value);
        out.states = normalized.length ? normalized : DEFAULT_STATES;
        i += v.consumed;
        break;
      }
      case "--families":
      case "--queue-families": {
        const v = readValue(i);
        out.families = splitList(v.value);
        i += v.consumed;
        break;
      }
      case "--limit": {
        const v = readValue(i);
        const text = String(v.value || "").trim().toLowerCase();
        out.limit = text === "all" ? "all" : Math.max(1, Number(text) || 50);
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
      case "--dial-priority": {
        const v = readValue(i);
        out.dialPriority = String(v.value || "").trim().toUpperCase() || "NORMAL";
        i += v.consumed;
        break;
      }
      case "--all-active-states":
        out.states = ACTIVE_STATES;
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

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function usage() {
  console.log(`
Mirror one agent's local CX queue rows into RingCX.

Dry-run:
  node scripts/cx-publish-agent-queue-to-ringcx.js --email agent@taxadvocategroup.com

Apply:
  node scripts/cx-publish-agent-queue-to-ringcx.js --extension-id 63756126004 --states claimed,serving --apply

Useful wider test:
  node scripts/cx-publish-agent-queue-to-ringcx.js --email agent@taxadvocategroup.com --all-active-states --limit 10 --apply

Reverse-order test:
  node scripts/cx-publish-agent-queue-to-ringcx.js --email mgray@taxadvocategroup.com --all-active-states --manual-test-tag mgray-cell-manual-dial --limit all --reverse --apply
`);
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function summarizeQueueItem(item) {
  return {
    id: String(item?._id || ""),
    domain: item?.domain || null,
    caseId: item?.caseId || null,
    name: item?.name || null,
    phone: maskPhone(item?.phone),
    state: item?.state || null,
    queueFamily: item?.queueFamily || null,
    actionKey: item?.metadata?.actionKey || null,
    manualTestTag: item?.metadata?.manualDialTest || null,
    existingRcxStatus: item?.metadata?.rcxVisibilityStatus || null,
    existingExternId:
      item?.metadata?.rcxVisibilityExternId ||
      item?.metadata?.lastRingcxPublishedExternId ||
      null,
  };
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  return mongoose.connection.name;
}

async function resolveAgent(options) {
  if (options.email) {
    const account = await userAccountRepository.findUserAccountByEmail(options.email);
    if (!account) throw new Error(`No user account found for ${options.email}`);
    if (!account.extensionId) throw new Error(`User ${options.email} has no extensionId`);
    return account;
  }
  if (options.extensionId) {
    const account = await userAccountRepository.findUserAccountByExtensionId(options.extensionId);
    if (account) return account;
    return {
      email: null,
      name: null,
      extensionId: options.extensionId,
      company: options.domain || null,
    };
  }
  throw new Error("Pass --email or --extension-id");
}

async function listAgentQueueItems(options, agent) {
  const filters = {
    states: options.states,
    visibleExtensionId: agent.extensionId,
    includeUnassignedVisible: options.includeUnassignedVisible,
    limitAll: options.limit === "all",
    limit: options.limit === "all" ? undefined : options.limit,
  };
  if (options.domain) filters.domain = options.domain;
  if (options.families.length) filters.queueFamilies = options.families;

  const rows = await cxDialQueueRepository.listQueueItems(filters);
  return rows.filter((item) => {
    const assigned = String(item?.assignment?.extensionId || "").trim();
    const agentExtensionId = String(agent.extensionId || "").trim();
    const matchesAgent = assigned === agentExtensionId || (!assigned && options.includeUnassignedVisible);
    if (!matchesAgent) return false;
    if (options.manualTestTag && String(item?.metadata?.manualDialTest || "") !== options.manualTestTag) {
      return false;
    }
    return true;
  });
}

function printPlan({ options, agent, dbName, items }) {
  console.log("CX queue -> RingCX one-off");
  console.log(`  mode:              ${options.apply ? "APPLY / writes RingCX" : "DRY RUN / no writes"}`);
  console.log(`  db:                ${dbName}`);
  console.log(`  agent:             ${agent.name || "(unknown)"} <${agent.email || "(no email)"}>`);
  console.log(`  extensionId:       ${agent.extensionId}`);
  console.log(`  domain filter:     ${options.domain || "(any)"}`);
  console.log(`  states:            ${options.states.join(",")}`);
  console.log(`  families:          ${options.families.length ? options.families.join(",") : "(any)"}`);
  console.log(`  limit:             ${options.limit}`);
  console.log(`  respectPresence:   ${options.respectPresence}`);
  console.log(`  force:             ${options.force}`);
  console.log(`  reverse:           ${options.reverse}`);
  console.log(`  manualTestTag:     ${options.manualTestTag || "(none)"}`);
  console.log(`  dialPriority:      ${options.dialPriority}`);
  console.log(`  matching rows:     ${items.length}`);
}

async function publishItems(options, items) {
  const summary = {
    attempted: 0,
    published: 0,
    reused: 0,
    skipped: 0,
    deferred: 0,
    errored: 0,
    ucqEnqueued: 0,
  };
  const details = [];
  for (const item of items) {
    summary.attempted += 1;
    const base = summarizeQueueItem(item);
    console.log(`\n[${summary.attempted}/${items.length}] case=${base.domain} ${base.caseId} ${base.name || ""} ${base.phone} state=${base.state} family=${base.queueFamily}`);
    if (!options.apply) {
      details.push({ ...base, dryRun: true });
      console.log(`  WOULD publish queueItemId=${base.id}`);
      continue;
    }

    const result = await publishQueueItemToRingcx({
      item,
      allowedStates: options.states,
      force: options.force,
      respectPresenceGate: options.respectPresence,
      dialPriority: options.dialPriority,
    });
    if (result?.published && result?.reused) summary.reused += 1;
    else if (result?.published) summary.published += 1;
    else if (result?.ucqEnqueued) summary.ucqEnqueued += 1;
    else if (result?.deferred) summary.deferred += 1;
    else if (result?.skipped) summary.skipped += 1;
    else if (result?.ok === false) summary.errored += 1;
    else summary.skipped += 1;

    details.push({
      ...base,
      ok: result?.ok !== false,
      published: Boolean(result?.published),
      reused: Boolean(result?.reused),
      skipped: Boolean(result?.skipped),
      deferred: Boolean(result?.deferred),
      reason: result?.reason || result?.error || null,
      campaignId: result?.campaignId || null,
      dialGroupId: result?.dialGroupId || null,
      externId: result?.externId || null,
      agentUsername: result?.agentUsername || null,
      loadSummary: result?.loadSummary || null,
    });
    console.log(`  result: ${JSON.stringify(details[details.length - 1])}`);
    if (options.apply && summary.attempted < items.length) await sleep(options.paceMs);
  }
  return { summary, details };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const invalidStates = options.states.filter((state) => !ACTIVE_STATES.includes(state));
  if (invalidStates.length) {
    throw new Error(`Invalid state(s): ${invalidStates.join(", ")}. Allowed: ${ACTIVE_STATES.join(", ")}`);
  }
  const dbName = await connectMongo();
  const agent = await resolveAgent(options);
  let items = await listAgentQueueItems(options, agent);
  if (options.reverse) items = [...items].reverse();
  printPlan({ options, agent, dbName, items });
  console.log("\nRows:");
  for (const item of items) {
    console.log(`  ${JSON.stringify(summarizeQueueItem(item))}`);
  }
  const result = await publishItems(options, items);
  console.log("\nSummary:");
  console.log(JSON.stringify(result.summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => null);
  });
