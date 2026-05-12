"use strict";

// Isolated CX manual-dial smoke lane for Mickey Gray.
//
// Creates a few CxDialQueue rows assigned only to mgray, all pointing at
// WYNN/101617, whose live Logics status is prospect/opened and whose phone is
// Mickey's cell. Rows are tagged so reruns only clear prior rows from this
// test lane.
//
// Usage:
//   node scripts/seed-mgray-manual-dial-test.js --count 3

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { CxDialQueue } = require("../packages/shared-models/src");
const { userAccountRepository } = require("../packages/shared-repositories/src");
const { createLogicsFacade } = require("../packages/shared-services/src/logicsFacadeService");

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const domain = String(readFlag(argv, "--domain", "WYNN") || "WYNN").trim().toUpperCase();
  const caseId = Number(readFlag(argv, "--case-id", "101617"));
  const phone = normalizePhone(readFlag(argv, "--phone", "3106665997"));
  const count = Math.min(Math.max(Number(readFlag(argv, "--count", "3")) || 3, 1), 12);
  const targetEmail = String(readFlag(argv, "--email", "mgray@taxadvocategroup.com")).trim().toLowerCase();
  const testTag = "mgray-cell-manual-dial";
  if (!Number.isFinite(caseId) || !phone) throw new Error("case-id and phone are required");

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  const agent = await userAccountRepository.findUserAccountByEmail(targetEmail);
  if (!agent?.extensionId) throw new Error(`No CX user/extension found for ${targetEmail}`);

  const live = await createLogicsFacade(domain).fetchCaseInfo(caseId);
  const liveStatus = Number(live?.status);
  if (!live?.ok || ![1, 2].includes(liveStatus)) {
    throw new Error(`Live Logics guard would block ${domain}/${caseId}: status=${live?.status || "unknown"}`);
  }

  const now = new Date();
  const claimUntil = new Date(now.getTime() + 90 * 60 * 1000);
  const cancelled = await CxDialQueue.updateMany(
    {
      "metadata.manualDialTest": testTag,
      state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
    },
    {
      $set: {
        state: "cancelled",
        cancelledAt: now,
        claimUntil: null,
        "metadata.cancelReason": "manual-dial-test-reset",
        "metadata.cancelledAt": now,
      },
    },
  );

  const ops = [];
  for (let index = 0; index < count; index += 1) {
    const actionKey = `${testTag}-${now.getTime()}-${index + 1}`;
    ops.push({
      updateOne: {
        filter: {
          domain,
          caseId,
          "metadata.actionKey": actionKey,
        },
        update: {
          $set: {
            domain,
            caseId,
            phone,
            name: "Mickey Manual Test",
            intakeSource: "manual-test",
            intakeRoute: "mgray-manual-dial",
            sourceName: "MGray Manual Dial Test",
            rcxDialGroupId: "1014",
            rcxCampaignId: "2347",
            state: "claimed",
            queueFamily: "fresh-day2to10",
            queueFamilyRank: 10,
            queueTier: "later",
            progressiveStageKey: "manual-test",
            progressiveStageIndex: 1,
            progressiveStageLabel: "Manual dial test",
            priorityScore: 1000 - index,
            releaseAt: now,
            claimUntil,
            lastClaimedAt: now,
            assignment: {
              extensionId: agent.extensionId,
              agentName: agent.name || agent.email || "Mickey Gray",
              assignedAt: now,
              queueFamilySnapshot: "fresh-day2to10",
            },
            callPlan: {
              phaseIndex: 0,
              delaysMinutes: [5, 5, 5],
              activeDay: 2,
              nextDelayMinutes: 5,
            },
            "metadata.actionKey": actionKey,
            "metadata.manualDialTest": testTag,
            "metadata.executionMode": "manual",
            "metadata.requestedBy": "seed-mgray-manual-dial-test",
            "metadata.servedAt": now,
            "metadata.servedToEmail": targetEmail,
            "metadata.assignedExtensionId": agent.extensionId,
            "metadata.assignedAgentName": agent.name || agent.email || "Mickey Gray",
            "metadata.rcxDialGroupId": "1014",
            "metadata.rcxCampaignId": "2347",
            "metadata.leadCreatedAt": now,
          },
          $setOnInsert: {
            placedCalls: 0,
            dailyPlacedCalls: 0,
          },
        },
        upsert: true,
      },
    });
  }

  const result = await CxDialQueue.bulkWrite(ops, { ordered: false });
  const rows = await CxDialQueue.find({
    "metadata.manualDialTest": testTag,
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  }).sort({ createdAt: -1 }).lean();

  console.log(JSON.stringify({
    ok: true,
    db: mongoose.connection.name,
    domain,
    caseId,
    phone,
    agent: {
      email: targetEmail,
      extensionId: agent.extensionId,
      name: agent.name || null,
    },
    liveStatus,
    cancelled: Number(cancelled.modifiedCount || 0),
    upserted: Number(result.upsertedCount || 0),
    modified: Number(result.modifiedCount || 0),
    activeRows: rows.map((row) => ({
      id: String(row._id),
      state: row.state,
      actionKey: row.metadata?.actionKey || null,
      assignedExtensionId: row.assignment?.extensionId || null,
      phone: row.phone,
      executionMode: row.metadata?.executionMode || null,
    })),
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
