"use strict";

// PILOT QUEUE TOOL (Sean's one-agent pilot, 2026-07-08). Builds and feeds the
// ISOLATED "pilot" queue family — the batch the floor can never touch:
//
//   * floor claim queries enumerate only the four floor families -> pilot rows are
//     invisible to the cadence assigner / refills / morning builder on BOTH boxes;
//   * a bulk session reserves the pilot family ONLY when this box's .env sets
//     CX_BULK_RESERVE_PILOT_FAMILY=pilot (cxReserveModeService pilot mode);
//   * rows are route-stamped to the pilot agent's own campaign/dial group, so the
//     reservation route-lock keeps every other bulk session out too.
//
// Subcommands (DRY-RUN by default — nothing writes without --arm):
//
//   build    select ~N safe-pool leads (active, un-queued, cold, not DNC) and mint
//            pilot rows.   --count 300 --domain WYNN --cooldown-days 30
//   refresh  THE NEW-STUFF TEE: move up to N brand-new, still-unassigned fresh-day1
//            first-contact rows into the pilot family (the rest of intake keeps
//            flowing to the floor untouched).   --max 5 --since-minutes 120
//   status   count pilot rows by state (read-only).
//   cleanup  cancel this batch's UNSERVED pilot rows (ready/claimed, never placed).
//   undo     restore refreshed (moved) rows back to fresh-day1.
//
// Every write stamps metadata.pilotBatch=<tag> so cleanup/undo touch ONLY what this
// tool created/moved. Default agent: slucas@ (route 50810001 / campaign 2344 / DG 1011
// read from env like the runtime does). PII: phones print last-4 only.
//
//   node scripts/cx-pilot-queue.js build --count 300            # dry-run preview
//   node scripts/cx-pilot-queue.js build --count 300 --arm      # write
//   node scripts/cx-pilot-queue.js refresh --max 5 --arm        # tee new leads
//   node scripts/cx-pilot-queue.js cleanup --tag pilot-slucas-20260708 --arm

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, LeadCadence } = require("../packages/shared-models/src");

const PILOT_FAMILY = "pilot";
const ACTIVE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
// mirror of cxWorkspaceService.isCxBlockedLeadCadence (module-local there)
const NON_DIALABLE_STAGE_PATTERN = /\b(dnc|do not call|post\s*date|post-date|sold|deal|bad inactive|inactive)\b/i;

const argv = process.argv.slice(2);
const cmd = argv[0];
function readFlag(name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1 && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}
const ARM = argv.includes("--arm");
const agentEmail = String(readFlag("--agent", "slucas@taxadvocategroup.com")).toLowerCase();
const domain = String(readFlag("--domain", "WYNN")).toUpperCase();

function agentRouteFromEnv(email) {
  const token = email.toUpperCase().replace(/@/g, "_AT_").replace(/[^A-Z0-9]/g, "_");
  const campaignId = process.env[`RINGCX_AGENT_ROUTE_${token}_CAMPAIGN_ID`];
  const dialGroupId = process.env[`RINGCX_AGENT_ROUTE_${token}_DIAL_GROUP_ID`];
  const accountId = process.env.RINGCX_ACCOUNT_ID || "50810001";
  if (!campaignId || !dialGroupId) {
    throw new Error(`no RINGCX_AGENT_ROUTE_* campaign/dial-group entries for ${email}`);
  }
  return { accountId: String(accountId), campaignId: String(campaignId), dialGroupId: String(dialGroupId) };
}

function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s || "-";
}
function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const defaultTag = `pilot-${agentEmail.split("@")[0]}-${dateKey()}`;
const tag = readFlag("--tag", defaultTag);

function blockedCadence(doc) {
  if (!doc.active) return true;
  const stage = String(doc.currentStage || "").trim();
  if (stage && NON_DIALABLE_STAGE_PATTERN.test(stage)) return true;
  const cxDnc = doc.cadenceState?.channelDnc?.cx;
  return Boolean(cxDnc?.blocked || doc.dncCheckpoints?.hit);
}

// ---- build: safe pool -> pilot rows ----
async function build(route) {
  const count = Math.max(Number(readFlag("--count", 300)) || 300, 1);
  const cooldownDays = Math.max(Number(readFlag("--cooldown-days", 30)) || 30, 1);
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);

  console.log(`BUILD ${ARM ? "(ARMED)" : "(dry-run)"} agent=${agentEmail} domain=${domain} tag=${tag}`);
  console.log(`  pool: active leads, no cx dial since ${cutoff.toISOString().slice(0, 10)}, no active queue row, not DNC/staged-out`);

  // cases that already have ANY active queue row are off-limits (one-active-row law:
  // a second row per case invites the findActiveQueueItem cross-wiring fallback)
  const busyCaseIds = await CxDialQueue.distinct("caseId", { domain, state: { $in: ACTIVE_STATES } });
  const busy = new Set(busyCaseIds.map(Number));
  console.log(`  excluded up front: ${busy.size} case(s) with an active queue row`);

  const cursor = LeadCadence.find({
    domain,
    active: true,
    $or: [
      { "counterCadence.lastCxDialedAt": null },
      { "counterCadence.lastCxDialedAt": { $lte: cutoff } },
    ],
    "cadenceState.channelDnc.cx.blocked": { $ne: true },
    "dncCheckpoints.hit": { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(count * 6) // headroom for per-doc filters
    .lean()
    .cursor();

  const picks = [];
  const seenCases = new Set();
  for await (const doc of cursor) {
    if (picks.length >= count) break;
    const caseId = Number(doc.caseId);
    if (!Number.isFinite(caseId) || busy.has(caseId) || seenCases.has(caseId)) continue;
    if (blockedCadence(doc)) continue;
    const phone = String(doc.primaryPhone || doc.normalizedPhone || "").trim();
    const name = String(doc.name || [doc.firstName, doc.lastName].filter(Boolean).join(" ")).trim();
    if (!phone || !name) continue; // publisher drops phoneless/nameless candidates
    seenCases.add(caseId);
    picks.push({ caseId, phone, name, leadCadenceId: String(doc._id) });
  }

  console.log(`  selected ${picks.length}/${count}`);
  for (const p of picks.slice(0, 8)) console.log(`    ${p.caseId} ${p.name} ${mask(p.phone)}`);
  if (picks.length > 8) console.log(`    ... +${picks.length - 8} more`);
  if (!ARM) return console.log("  dry-run: nothing written. Re-run with --arm.");

  const now = new Date();
  const ops = picks.map((p, i) => ({
    updateOne: {
      filter: { domain, caseId: p.caseId, "metadata.actionKey": `${tag}-${p.caseId}`, state: { $in: ACTIVE_STATES } },
      update: {
        $setOnInsert: {
          domain,
          caseId: p.caseId,
          leadCadenceId: p.leadCadenceId,
          phone: p.phone,
          name: p.name,
          state: "ready",
          queueFamily: PILOT_FAMILY,
          queueFamilyRank: i,
          priorityScore: 100,
          releaseAt: now,
          rcxAccountId: route.accountId,
          rcxCampaignId: route.campaignId,
          rcxDialGroupId: route.dialGroupId,
          metadata: {
            actionKey: `${tag}-${p.caseId}`,
            pilotBatch: tag,
            pilotAgentEmail: agentEmail,
            requestedBy: "pilot-queue-build",
          },
        },
      },
      upsert: true,
    },
  }));
  const res = await CxDialQueue.bulkWrite(ops, { ordered: false });
  console.log(`  WROTE ${res.upsertedCount} pilot row(s) (skipped ${picks.length - res.upsertedCount} pre-existing).`);
  console.log(`  cleanup later: node scripts/cx-pilot-queue.js cleanup --tag ${tag} --arm`);
}

// ---- refresh: the new-stuff tee (move, never copy — one active row per case) ----
async function refresh(route) {
  const max = Math.max(Number(readFlag("--max", 5)) || 5, 1);
  const sinceMinutes = Math.max(Number(readFlag("--since-minutes", 120)) || 120, 1);
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);

  console.log(`REFRESH ${ARM ? "(ARMED)" : "(dry-run)"} tee up to ${max} new lead(s) minted since ${since.toISOString().slice(11, 16)}Z -> ${PILOT_FAMILY}`);
  const candidates = await CxDialQueue.find({
    domain,
    state: "ready",
    queueFamily: "fresh-day1",
    createdAt: { $gte: since },
    "assignment.extensionId": null, // untouched by the floor: nobody loses a lead
    "metadata.requestedBy": "intake-first-contact",
  })
    .sort({ createdAt: 1 })
    .limit(max)
    .lean();

  if (!candidates.length) return console.log("  no un-assigned fresh intake rows in the window — nothing to tee.");
  for (const c of candidates) console.log(`    ${c.caseId} ${c.name || "?"} ${mask(c.phone)} minted=${String(c.createdAt).slice(11, 19)}`);
  if (!ARM) return console.log("  dry-run: nothing moved. Re-run with --arm.");

  const res = await CxDialQueue.updateMany(
    { _id: { $in: candidates.map((c) => c._id) }, state: "ready", "assignment.extensionId": null },
    {
      $set: {
        queueFamily: PILOT_FAMILY,
        rcxAccountId: route.accountId,
        rcxCampaignId: route.campaignId,
        rcxDialGroupId: route.dialGroupId,
        "metadata.pilotBatch": tag,
        "metadata.pilotAgentEmail": agentEmail,
        "metadata.pilotTeeFromFamily": "fresh-day1",
      },
    },
  );
  console.log(`  MOVED ${res.modifiedCount} row(s) into the pilot family (undo: node scripts/cx-pilot-queue.js undo --tag ${tag} --arm).`);
}

// ---- status / cleanup / undo ----
async function status() {
  const rows = await CxDialQueue.aggregate([
    { $match: { domain, queueFamily: PILOT_FAMILY } },
    { $group: { _id: { state: "$state", batch: "$metadata.pilotBatch" }, n: { $sum: 1 } } },
    { $sort: { "_id.batch": 1, "_id.state": 1 } },
  ]);
  console.log(`PILOT ROWS (${domain})`);
  if (!rows.length) console.log("  none");
  for (const r of rows) console.log(`  ${r._id.batch || "(untagged)"}  ${r._id.state}: ${r.n}`);
}

async function cleanup() {
  const filter = {
    domain,
    queueFamily: PILOT_FAMILY,
    "metadata.pilotBatch": tag,
    state: { $in: ["ready", "claimed"] },
    placedCalls: 0, // never cancel a row that already dialed — its ledger is real
  };
  const n = await CxDialQueue.countDocuments(filter);
  console.log(`CLEANUP ${ARM ? "(ARMED)" : "(dry-run)"} tag=${tag}: ${n} unserved pilot row(s) -> cancelled`);
  if (!ARM || !n) return;
  const res = await CxDialQueue.updateMany(filter, {
    $set: { state: "cancelled", cancelledAt: new Date(), "metadata.pilotCleanup": new Date().toISOString() },
  });
  console.log(`  cancelled ${res.modifiedCount}`);
}

async function undo() {
  const filter = {
    domain,
    queueFamily: PILOT_FAMILY,
    "metadata.pilotBatch": tag,
    "metadata.pilotTeeFromFamily": "fresh-day1",
    state: "ready",
    placedCalls: 0,
  };
  const n = await CxDialQueue.countDocuments(filter);
  console.log(`UNDO ${ARM ? "(ARMED)" : "(dry-run)"} tag=${tag}: ${n} teed row(s) -> back to fresh-day1`);
  if (!ARM || !n) return;
  const res = await CxDialQueue.updateMany(filter, {
    $set: { queueFamily: "fresh-day1" },
    $unset: { "metadata.pilotBatch": "", "metadata.pilotAgentEmail": "", "metadata.pilotTeeFromFamily": "" },
  });
  console.log(`  restored ${res.modifiedCount}`);
}

async function main() {
  if (!["build", "refresh", "status", "cleanup", "undo"].includes(cmd)) {
    console.error("Usage: node scripts/cx-pilot-queue.js <build|refresh|status|cleanup|undo> [--arm] [--agent e] [--domain D] [--count N] [--max N] [--tag T]");
    process.exit(2);
  }
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const route = agentRouteFromEnv(agentEmail);
  console.log(`route: account ${route.accountId} / campaign ${route.campaignId} / dial group ${route.dialGroupId}`);
  if (cmd === "build") await build(route);
  else if (cmd === "refresh") await refresh(route);
  else if (cmd === "status") await status();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "undo") await undo();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`pilot queue tool failed: ${err.message}`);
  process.exit(1);
});
