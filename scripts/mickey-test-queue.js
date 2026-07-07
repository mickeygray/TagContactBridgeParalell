#!/usr/bin/env node
"use strict";

// Mickey isolated TEST dialing queue (for voicemail-drop / barge testing).
//
//   node scripts/mickey-test-queue.js status            # read-only: policy + Mickey's queue items
//   node scripts/mickey-test-queue.js isolate [--apply] # stop auto lead assignment to Mickey
//   node scripts/mickey-test-queue.js restore [--apply] # re-enable normal lead assignment
//   node scripts/mickey-test-queue.js seed   [--apply]  # add ONE test lead (3106665997) claimed to Mickey
//   node scripts/mickey-test-queue.js bulk   [--apply]  # add tagged bulk test leads claimed to Mickey
//
// isolate sets cxQueuePolicy.enabled=false (load-balancer eligibility gate 1 -> no
// real leads). seed uses the system's enqueueCxSmokeLead to make a valid item, then
// pre-claims it to Mickey and forces phone=3106665997 so it shows in HIS queue and
// dials YOUR number. Reversible; dry-run unless --apply.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const CxDialQueue = require("../packages/shared-models/src/CxDialQueue");

const EMAIL = "mgray@taxadvocategroup.com";
const EXT_ID = "63730035004"; // Mickey extensionId
const AGENT_NAME = "Mickey Gray";
const TEST_PHONE = "3106665997";
const DOMAIN = "TAG";
const ROUTE_CAMPAIGN_KEY = "mickey-test";
const ROUTE_CAMPAIGN_NAME = "Mickey Test";
const BULK_TEST_TAG = "mgray-simple-loop-bulk";
const BULK_BASE_CASE_ID = 990000;
const BULK_PROFILES = Object.freeze([
  {
    queueFamily: "fresh-day1",
    queueFamilyRank: 0,
    queueTier: "day0",
    progressiveStageKey: "just-came-in",
    progressiveStageIndex: 0,
    progressiveStageLabel: "Just came in",
    priorityBase: 100000,
  },
  {
    queueFamily: "fresh-day2to10",
    queueFamilyRank: 1,
    queueTier: "day1",
    progressiveStageKey: "second-contact",
    progressiveStageIndex: 1,
    progressiveStageLabel: "Second contact",
    priorityBase: 90000,
  },
  {
    queueFamily: "fresh-day2to10",
    queueFamilyRank: 1,
    queueTier: "day1",
    progressiveStageKey: "third-contact",
    progressiveStageIndex: 2,
    progressiveStageLabel: "Third contact",
    priorityBase: 85000,
  },
  {
    queueFamily: "fresh-day16to30",
    queueFamilyRank: 2,
    queueTier: "later",
    progressiveStageKey: "day16to30",
    progressiveStageIndex: 3,
    progressiveStageLabel: "Day 16 to 30",
    priorityBase: 70000,
  },
  {
    queueFamily: "aged",
    queueFamilyRank: 3,
    queueTier: "later",
    progressiveStageKey: "aged-cadence",
    progressiveStageIndex: 4,
    progressiveStageLabel: "Aged cadence",
    priorityBase: 60000,
  },
]);

const MICKEY_USER = {
  email: EMAIL, name: AGENT_NAME, company: DOMAIN, role: "admin", audience: "user",
  extensionId: EXT_ID, cxAgentId: "21018", workspace: "cx",
};

function readArgValue(names, fallback = null) {
  const flags = Array.isArray(names) ? names : [names];
  for (let i = 0; i < process.argv.length; i += 1) {
    const raw = String(process.argv[i] || "");
    for (const flag of flags) {
      if (raw === flag) return process.argv[i + 1] ?? fallback;
      if (raw.startsWith(`${flag}=`)) return raw.slice(flag.length + 1);
    }
  }
  return fallback;
}

function parsePositiveInteger(value, fallback, max = null) {
  const parsed = Number(value);
  const next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return max ? Math.min(next, max) : next;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function connect() {
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  return dbName;
}

async function setPolicyEnabled(apply, enabled) {
  const col = mongoose.connection.db.collection("useraccounts");
  const before = await col.findOne({ email: EMAIL }, { projection: { name: 1, "cxQueuePolicy.enabled": 1, "cxQueuePolicy.tier": 1 } });
  if (!before) { console.log(`no account for ${EMAIL}`); return; }
  console.log(`current: enabled=${before.cxQueuePolicy?.enabled} tier=${before.cxQueuePolicy?.tier ?? "(none)"}`);
  console.log(`${apply ? "WRITING" : "WOULD"}: cxQueuePolicy.enabled -> ${enabled}`);
  if (apply) {
    await col.updateOne(
      { _id: before._id },
      { $set: { "cxQueuePolicy.enabled": enabled, "cxQueuePolicy.updatedAt": new Date(), "cxQueuePolicy.updatedBy": "mickey-test-queue" } },
    );
    console.log("done.");
  }
}

async function status() {
  const col = mongoose.connection.db.collection("useraccounts");
  const acct = await col.findOne({ email: EMAIL }, { projection: { name: 1, extensionId: 1, cxQueuePolicy: 1 } });
  console.log(`Mickey: ${acct?.name} extId=${acct?.extensionId}`);
  console.log(`  cxQueuePolicy.enabled=${acct?.cxQueuePolicy?.enabled}  tier=${acct?.cxQueuePolicy?.tier ?? "(none)"}`);

  const mine = await CxDialQueue.find(
    { domain: DOMAIN, "assignment.extensionId": EXT_ID, state: { $in: ["queued", "ready", "claimed", "serving", "paused"] } },
    { caseId: 1, phone: 1, state: 1, queueFamily: 1, priorityScore: 1, "metadata.testLead": 1, "metadata.actionKey": 1, "metadata.manualDialTest": 1 },
  ).lean();
  console.log(`  active queue items assigned to Mickey: ${mine.length}  (collection=${CxDialQueue.collection.name})`);
  for (const it of mine) {
    console.log(`    caseId=${it.caseId} phone=${it.phone} state=${it.state} family=${it.queueFamily} priority=${it.priorityScore} test=${Boolean(it.metadata?.testLead)} tag=${it.metadata?.manualDialTest || "-"} actionKey=${it.metadata?.actionKey || "-"}`);
  }
}

async function seed(apply) {
  const services = require("../packages/shared-services/src");
  if (typeof services.enqueueCxSmokeLead !== "function") throw new Error("enqueueCxSmokeLead not exported");

  if (!apply) {
    console.log(`WOULD: enqueueCxSmokeLead(${DOMAIN}, Mickey, { phone: ${TEST_PHONE} }) then pre-claim to Mickey + force phone=${TEST_PHONE}`);
    console.log("(dry-run: no Logics call, no write) -- re-run with --apply to actually seed");
    return;
  }

  // enqueueCxSmokeLead only seeds LeadCadence (so disposition/case panel work) +
  // confirms the Logics case exists. It does NOT create the CxDialQueue row -- that
  // is normally materialized by the workspace refill, which we've disabled. So we
  // create the dial-queue item ourselves, assigned to Mickey, phone forced to YOUR
  // number. Fixed actionKey => re-running re-arms the SAME item after a disposition.
  // Default to "claimed": a "ready" item assigned to a policy-disabled agent gets
  // auto-cancelled by the idle/sweep reaper; "claimed" persists.
  const stateArg = (process.argv.find((a) => a.startsWith("--state=")) || "").split("=")[1];
  const state = stateArg === "ready" || stateArg === "claimed" ? stateArg : "claimed";

  console.log(`enqueueCxSmokeLead(${DOMAIN}, Mickey, { phone: ${TEST_PHONE} }) ...`);
  const result = await services.enqueueCxSmokeLead(DOMAIN, MICKEY_USER, { phone: TEST_PHONE, queueFamily: "fresh-day1" });
  const caseId = Number(result?.caseId);
  console.log(`  LeadCadence/Logics case ready: caseId=${caseId} name=${result?.item?.name || "-"}`);

  const now = new Date();
  const actionKey = `mickey-test:${caseId}`;
  const item = await CxDialQueue.findOneAndUpdate(
    { domain: DOMAIN, caseId, "metadata.actionKey": actionKey },
    {
      $set: {
        domain: DOMAIN,
        caseId,
        phone: TEST_PHONE, // dial YOUR number regardless of the Logics record
        name: result?.item?.name || "Mickey Test Lead",
        state,
        routeCampaignKey: ROUTE_CAMPAIGN_KEY,
        routeCampaignName: ROUTE_CAMPAIGN_NAME,
        queueFamily: "fresh-day1",
        queueFamilyRank: 0,
        queueTier: "day0",
        priorityScore: 100000, // sort to the very top of Mickey's list
        releaseAt: now,
        claimUntil: state === "claimed" ? new Date(now.getTime() + 8 * 3600 * 1000) : null,
        lastClaimedAt: state === "claimed" ? now : null,
        completedAt: null,
        cancelledAt: null,
        "assignment.extensionId": EXT_ID,
        "assignment.agentName": AGENT_NAME,
        "assignment.assignedAt": now,
        "metadata.actionKey": actionKey,
        "metadata.routeCampaignKey": ROUTE_CAMPAIGN_KEY,
        "metadata.routeCampaignName": ROUTE_CAMPAIGN_NAME,
        "metadata.testLead": true,
        "metadata.testSeededAt": now.toISOString(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  console.log(`  dial-queue item upserted: _id=${item._id} state=${item.state} phone=${item.phone} assignedTo=${item.assignment?.extensionId}`);
  console.log("  -> should now appear in Mickey's dialing queue. Re-run `seed --apply` to re-arm after a disposition.");
  console.log("     (try `--state=claimed` if a 'ready' item doesn't show as loadable in the workspace)");
}

async function seedBulk(apply) {
  const count = parsePositiveInteger(readArgValue(["--count", "-n"], 30), 30, 50);
  const baseCaseId = parsePositiveInteger(readArgValue("--base-case", BULK_BASE_CASE_ID), BULK_BASE_CASE_ID);
  const phone = normalizePhone(readArgValue("--phone", TEST_PHONE));
  const tag = String(readArgValue("--tag", BULK_TEST_TAG) || BULK_TEST_TAG).trim();
  const replace = process.argv.includes("--replace");
  const stateArg = String(readArgValue("--state", "claimed") || "claimed").trim().toLowerCase();
  const state = stateArg === "ready" || stateArg === "claimed" ? stateArg : "claimed";
  const flat = process.argv.includes("--flat");

  if (!phone) throw new Error("bulk seed requires --phone or TEST_PHONE");
  console.log(`${apply ? "WRITING" : "WOULD"}: seed ${count} Mickey bulk test row(s) tag=${tag} phone=${phone} state=${state}`);
  console.log(`  baseCaseId=${baseCaseId} replace=${replace} shape=${flat ? "flat" : "realistic-queue-profile"}`);
  if (!apply) {
    console.log("  dry-run only. Re-run with --apply to write queue rows.");
    return;
  }

  if (replace) {
    const del = await CxDialQueue.deleteMany({
      domain: DOMAIN,
      "metadata.testLead": true,
      "metadata.manualDialTest": tag,
    });
    console.log(`  replaced: deleted ${del.deletedCount} old tagged row(s)`);
  }

  const now = new Date();
  const claimUntil = state === "claimed" ? new Date(now.getTime() + 8 * 3600 * 1000) : null;
  const operations = [];
  for (let i = 0; i < count; i += 1) {
    const profile = flat ? BULK_PROFILES[0] : BULK_PROFILES[i % BULK_PROFILES.length];
    const caseId = baseCaseId + i;
    const actionKey = `mickey-test:${tag}:${caseId}`;
    const priorityScore = profile.priorityBase - Math.floor(i / BULK_PROFILES.length);
    operations.push({
      updateOne: {
        filter: { domain: DOMAIN, caseId, "metadata.actionKey": actionKey },
        update: {
          $set: {
            domain: DOMAIN,
            caseId,
            phone,
            name: `Mickey ${profile.progressiveStageLabel} ${String(i + 1).padStart(2, "0")}`,
            state,
            routeCampaignKey: ROUTE_CAMPAIGN_KEY,
            routeCampaignName: ROUTE_CAMPAIGN_NAME,
            intakeSource: "mickey-bulk-test",
            intakeRoute: "cx-bulk-load-local-test",
            sourceName: "Mickey local bulk test",
            queueFamily: profile.queueFamily,
            queueFamilyRank: profile.queueFamilyRank,
            queueTier: profile.queueTier,
            progressiveStageKey: profile.progressiveStageKey,
            progressiveStageIndex: profile.progressiveStageIndex,
            progressiveStageLabel: profile.progressiveStageLabel,
            priorityScore,
            releaseAt: now,
            claimUntil,
            lastClaimedAt: state === "claimed" ? now : null,
            completedAt: null,
            cancelledAt: null,
            placedCalls: 0,
            lastPlacedAt: null,
            dailyPlacedDateKey: null,
            dailyPlacedCalls: 0,
            monthlyPlacedMonthKey: null,
            monthlyPlacedCalls: 0,
            hourlyPlacedHourKey: null,
            hourlyPlacedCalls: 0,
            callPlan: {
              phaseIndex: profile.progressiveStageIndex,
              delaysMinutes: [0, 15, 15, 15, 15, 15],
              activeDay: 0,
              nextDelayMinutes: 0,
            },
            rcxAccountId: null,
            rcxDialGroupId: null,
            rcxCampaignId: null,
            "assignment.extensionId": EXT_ID,
            "assignment.agentName": AGENT_NAME,
            "assignment.assignedAt": now,
            "assignment.queueFamilySnapshot": profile.queueFamily,
            "metadata.actionKey": actionKey,
            "metadata.routeCampaignKey": ROUTE_CAMPAIGN_KEY,
            "metadata.routeCampaignName": ROUTE_CAMPAIGN_NAME,
            "metadata.queueFamily": profile.queueFamily,
            "metadata.queueFamilyRank": profile.queueFamilyRank,
            "metadata.progressiveStageKey": profile.progressiveStageKey,
            "metadata.progressiveStageIndex": profile.progressiveStageIndex,
            "metadata.progressiveStageLabel": profile.progressiveStageLabel,
            "metadata.testLead": true,
            "metadata.manualDialTest": tag,
            "metadata.bulkLoadTest": true,
            "metadata.testSeededAt": now.toISOString(),
            "metadata.rcxVisibilityStatus": null,
            "metadata.rcxVisibilityExternId": null,
            "metadata.rcxVisibilityCampaignId": null,
            "metadata.rcxVisibilityDialGroupId": null,
            "metadata.lastRingcxPublishedAt": null,
            "metadata.lastRingcxPublishedExternId": null,
            "metadata.lastRingcxPublishedCampaignId": null,
            "metadata.lastRingcxPublishedDialGroupId": null,
          },
        },
        upsert: true,
      },
    });
  }

  const result = await CxDialQueue.bulkWrite(operations, { ordered: false });
  console.log(`  matched=${result.matchedCount || 0} modified=${result.modifiedCount || 0} upserted=${result.upsertedCount || 0}`);
  console.log("  -> open /cx and load through the bulk rail; the simple-loop harness is retired.");
  console.log("     Note: if every row uses the same phone, treat this as app-state evidence, not RingCX ordering evidence.");
}

// Full teardown: delete the test dial-queue item(s) and re-enable normal lead flow.
// Scoped strictly to Mickey + metadata.testLead items so nothing leaks to production.
async function clear(apply) {
  const test = await CxDialQueue.find(
    { domain: DOMAIN, "metadata.testLead": true, "metadata.manualDialTest": BULK_TEST_TAG },
    { caseId: 1, phone: 1, state: 1 },
  ).lean();
  console.log(`bulk test items found (${BULK_TEST_TAG}): ${test.length}`);
  for (const it of test) console.log(`    caseId=${it.caseId} phone=${it.phone} state=${it.state}`);
  console.log(`${apply ? "WRITING" : "WOULD"}: delete ${test.length} test item(s) + set cxQueuePolicy.enabled=true`);
  if (apply) {
    const del = await CxDialQueue.deleteMany({ domain: DOMAIN, "metadata.testLead": true, "metadata.manualDialTest": BULK_TEST_TAG });
    console.log(`  deleted ${del.deletedCount} test item(s)`);
    await setPolicyEnabled(true, true);
  }
}

(async () => {
  const cmd = (process.argv[2] || "status").trim();
  const apply = process.argv.includes("--apply");
  const dbName = await connect();
  console.log(`DB=${dbName}  cmd=${cmd}  ${apply ? "APPLY" : "(dry-run)"}\n`);
  try {
    if (cmd === "status") await status();
    else if (cmd === "isolate") await setPolicyEnabled(apply, false);
    else if (cmd === "restore") await setPolicyEnabled(apply, true);
    else if (cmd === "seed") await seed(apply);
    else if (cmd === "bulk" || cmd === "seed-bulk") await seedBulk(apply);
    else if (cmd === "clear") await clear(apply);
    else console.log(`unknown command: ${cmd}`);
  } finally {
    await mongoose.disconnect();
  }
})().catch(async (e) => {
  console.error("failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
