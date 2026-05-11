"use strict";

// Serve N random filler-pool leads into a specific agent's CX queue.
//
// Picks N random rows from MPI where `pool.tag = current-month`,
// creates a CxDialQueue item per row, and locks each to the target
// agent's extensionId so they show up dialable in the agent's /cx
// workspace immediately.
//
// Usage:
//   node scripts/serve-filler-to-agent.js                              # mgray, 10
//   node scripts/serve-filler-to-agent.js --email user@... --count 5
//   node scripts/serve-filler-to-agent.js --tag filler-2026-05

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CxDialQueue,
  MasterProspectIndex,
} = require("../packages/shared-models/src");
const {
  userAccountRepository,
} = require("../packages/shared-repositories/src");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function defaultMonthTag(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `filler-${year}-${month}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const targetEmail = readFlag(argv, "--email") || "mgray@taxadvocategroup.com";
  const count = Math.min(Math.max(Number(readFlag(argv, "--count")) || 10, 1), 100);
  const tag = readFlag(argv, "--tag") || defaultMonthTag(new Date());

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log(`══ Serve filler to agent ══`);
  console.log(`  agent email: ${targetEmail}`);
  console.log(`  count:       ${count}`);
  console.log(`  pool tag:    ${tag}\n`);

  const agent = await userAccountRepository.findUserAccountByEmail(targetEmail);
  if (!agent) {
    throw new Error(`Agent not found: ${targetEmail}`);
  }
  if (!agent.extensionId) {
    throw new Error(`Agent ${targetEmail} has no extensionId — can't assign queue items`);
  }
  console.log(`[agent] resolved ext=${agent.extensionId} name="${agent.name || "?"}"\n`);

  // Random sample from the pool
  const samples = await MasterProspectIndex.aggregate([
    { $match: { "pool.tag": tag } },
    { $sample: { size: count } },
  ]);
  console.log(`[sample] pulled ${samples.length} random pool members:`);
  for (const s of samples) {
    console.log(`  ${s.domain}/${String(s.caseId).padStart(7)} ${(s.name || "(no-name)").padEnd(28)} ${s.normalizedPhones?.[0] || "(no-phone)"}`);
  }
  console.log("");

  if (samples.length === 0) {
    console.log("Pool is empty — nothing to serve.");
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  const farFuture = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const ops = [];

  for (const s of samples) {
    // CxDialQueue identity is (domain, caseId, metadata.actionKey).
    // Use a unique actionKey per serve so we don't collide with any
    // pre-existing queue rows for the same case.
    const actionKey = `filler-serve-${now.getTime()}-${s.caseId}`;
    ops.push({
      updateOne: {
        filter: {
          domain: s.domain,
          caseId: s.caseId,
          "metadata.actionKey": actionKey,
        },
        update: {
          $set: {
            domain: s.domain,
            caseId: s.caseId,
            phone: s.normalizedPhones?.[0] || null,
            name: s.name || null,
            intakeSource: "filler",
            intakeRoute: "filler-served",
            sourceName: s.metadata?.sourceName || "Filler Pool",
            state: "claimed",
            claimUntil: farFuture,
            // Filler pool = aged leads (months/years old). The UI maps
            // queueFamily="aged" to a red dot + "Aged" label. We
            // intentionally avoid "fresh-day1" so these don't show up
            // with the green-dot "New" badge that signals just-in
            // intake.
            //
            // Note: schema enum is fresh-day1 | fresh-day2to10 | aged |
            // unassigned — anything else (e.g. "filler") gets coerced
            // to "unassigned", and then UI's inferQueueFamily() falls
            // back to callPlan.activeDay where activeDay=0 maps to
            // "fresh-day1" (green dot). So we also bump activeDay to
            // 99 as belt-and-suspenders.
            queueFamily: "aged",
            queueFamilyRank: 99,
            queueTier: "later",
            progressiveStageKey: "filler-pool",
            progressiveStageIndex: 99,
            progressiveStageLabel: "Filler",
            priorityScore: 100,
            releaseAt: now,
            lastClaimedAt: now,
            assignment: {
              extensionId: agent.extensionId,
              agentName: agent.name || agent.email,
              assignedAt: now,
              queueFamilySnapshot: "aged",
            },
            callPlan: {
              phaseIndex: 0,
              delaysMinutes: [60, 120, 240],
              activeDay: 99,
              nextDelayMinutes: 60,
            },
            "metadata.actionKey": actionKey,
            "metadata.servedFrom": tag,
            "metadata.servedAt": now,
            "metadata.servedToEmail": targetEmail,
            "metadata.requestedBy": "serve-filler-to-agent",
            "metadata.executionOwner": "ringcentral-cx",
            "metadata.futureAdapterPort": 6101,
          },
          $setOnInsert: {
            placedCalls: 0,
          },
        },
        upsert: true,
      },
    });
  }

  const result = await CxDialQueue.bulkWrite(ops, { ordered: false });
  console.log(`[queue] upserted=${result.upsertedCount} modified=${result.modifiedCount}`);

  // Verify
  const claimed = await CxDialQueue.find({
    "assignment.extensionId": agent.extensionId,
    "metadata.servedFrom": tag,
    state: { $in: ["queued", "ready", "claimed", "serving"] },
  }).lean();
  console.log(`\n[verify] ${claimed.length} active filler items locked to ${agent.extensionId}:`);
  for (const c of claimed) {
    console.log(`  ${c.domain}/${String(c.caseId).padStart(7)} state=${c.state} ${(c.name || "").padEnd(25)} ${c.phone || ""}`);
  }

  await mongoose.disconnect();
  console.log(`\n[done] ${samples.length} filler leads served to ${agent.email}`);
}

main().catch((error) => {
  console.error("[serve] FATAL:", error.stack || error.message);
  process.exit(1);
});
