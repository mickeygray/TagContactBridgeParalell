#!/usr/bin/env node
"use strict";

// Chris combined canary prep/finalizer.
//
// Dry-run by default. The order is intentional:
//   1. Prove Chris is isolated from regular-floor cadence.
//   2. Build the Chris pilot pool through cx-pilot-queue.js.
//   3. Apply RingCX priority LAST, only when explicitly armed.
//
// Write gates:
//   --isolate-apply            or CX_CHRIS_CANARY_APPLY_ISOLATION=true
//   --queue-arm                 or CX_CHRIS_CANARY_ARM_QUEUE=true
//   --apply-ringcx              or CX_CHRIS_CANARY_APPLY_RINGCX=true
//
// This script never edits .env and never restarts services.

const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { getSharedConfig } = require("../packages/shared-config/src");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { CxDialQueue } = require("../packages/shared-models/src");
const { agentStateRepository } = require("../packages/shared-repositories/src");
const { releaseCxQueueItem } = require("../packages/shared-services/src/cxCadenceService");

const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET = Object.freeze({
  email: "cbolt@taxadvocategroup.com",
  name: "Chris Bolt",
  domain: "WYNN",
  extensionId: "63914586004",
  accountId: "50810001",
  dialGroupId: "1068",
  campaigns: Object.freeze([
    { key: "regular", label: "Chris regular/bulk", campaignId: "2458", priority: 1 },
    { key: "firstTouch", label: "Chris First Touch", campaignId: "2829", priority: 5 },
    { key: "appointment", label: "Chris Appointment", campaignId: "2900", priority: 10 },
  ]),
});

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1 && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

const ACTIVE_QUEUE_STATES = Object.freeze(["queued", "ready", "claimed", "serving", "paused"]);
const SAFE_PILOT_PAUSE_TYPES = Object.freeze(["work-pause", "logout"]);

function normalizePauseType(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeQueueFamily(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCampaignId(value) {
  return String(value || "").trim();
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `***${digits.slice(-4)}` : null;
}

function shortId(value) {
  const raw = String(value || "").trim();
  return raw.length > 10 ? raw.slice(-10) : raw;
}

function todayTag() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function pick(row, keys) {
  const out = {};
  for (const key of keys) out[key] = row?.[key] ?? null;
  return out;
}

function campaignName(row) {
  return row?.campaignName || row?.name || "";
}

function printHeader(title) {
  console.log(`\n== ${title} ==`);
}

function printEnvPlan() {
  printHeader("Target local env for Chris combined canary");
  console.log("CX_BULK_RESERVE_PILOT_FAMILY=pilot");
  console.log("CX_ALPHA_TRACE_AGENT=cbolt@taxadvocategroup.com");
  console.log("CX_FIRST_TOUCH_ENABLED=true");
  console.log('CX_FIRST_TOUCH_QUEUE_MAP={"cbolt@taxadvocategroup.com":2829}');
  console.log("CX_APPT_LANE_ENABLED=true");
  console.log('CX_APPT_QUEUE_MAP={"cbolt@taxadvocategroup.com":2900}');

  printHeader("Current local env snapshot");
  for (const key of [
    "CX_BULK_RESERVE_PILOT_FAMILY",
    "CX_ALPHA_TRACE_AGENT",
    "CX_FIRST_TOUCH_ENABLED",
    "CX_FIRST_TOUCH_QUEUE_MAP",
    "CX_APPT_LANE_ENABLED",
    "CX_APPT_QUEUE_MAP",
  ]) {
    console.log(`${key}=${process.env[key] || ""}`);
  }
}

function classifyAssignedQueueItem(item) {
  const family = normalizeQueueFamily(item?.queueFamily || item?.metadata?.queueFamily);
  const campaignId = normalizeCampaignId(item?.rcxCampaignId || item?.metadata?.rcxCampaignId);
  if (family === "pilot") return "pilot";
  if (campaignId === TARGET.campaigns[1].campaignId) return "lane:first-touch";
  if (campaignId === TARGET.campaigns[2].campaignId) return "lane:appointment";
  return "regular-clash";
}

function summarizeItems(items) {
  const summary = new Map();
  for (const item of items) {
    const key = [
      classifyAssignedQueueItem(item),
      item.state || "unknown",
      item.queueFamily || "unknown-family",
      item.rcxCampaignId || "no-campaign",
    ].join("|");
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  return Array.from(summary.entries()).map(([key, count]) => {
    const [classification, state, queueFamily, campaignId] = key.split("|");
    return { classification, state, queueFamily, campaignId, count };
  });
}

function itemSample(item) {
  return {
    id: shortId(item?._id),
    caseId: item?.caseId ?? null,
    state: item?.state || null,
    queueFamily: item?.queueFamily || null,
    campaignId: item?.rcxCampaignId || null,
    phone: maskPhone(item?.phone),
    placedCalls: Number(item?.placedCalls || 0),
    publishedExternId: item?.metadata?.rcxVisibilityExternId
      ? shortId(item.metadata.rcxVisibilityExternId)
      : null,
    pilotBatch: item?.metadata?.pilotBatch || null,
  };
}

async function readChrisIsolationState() {
  const config = getSharedConfig();
  await connectMongo(config);
  const [agentState, assignedItems] = await Promise.all([
    agentStateRepository.findAgentStateByExtensionId(TARGET.extensionId),
    CxDialQueue.find({
      state: { $in: ACTIVE_QUEUE_STATES },
      "assignment.extensionId": TARGET.extensionId,
    })
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .lean(),
  ]);
  return {
    agentState,
    assignedItems,
    regularClashes: assignedItems.filter((item) => classifyAssignedQueueItem(item) === "regular-clash"),
    laneItems: assignedItems.filter((item) => classifyAssignedQueueItem(item).startsWith("lane:")),
    pilotItems: assignedItems.filter((item) => classifyAssignedQueueItem(item) === "pilot"),
  };
}

function evaluateChrisIsolation(state) {
  const desiredAvailability = normalizePauseType(state.agentState?.cxRouting?.desiredAvailability);
  const pauseType = normalizePauseType(state.agentState?.cxRouting?.pauseType);
  const pauseReleaseAt = state.agentState?.cxRouting?.pauseReleaseAt || null;
  const isUnavailable = desiredAvailability === "unavailable";
  const isSafePause =
    pauseType === "work-pause"
      ? !pauseReleaseAt
      : SAFE_PILOT_PAUSE_TYPES.includes(pauseType);
  const errors = [];
  const warnings = [];

  if (!state.agentState) {
    errors.push(`No AgentState found for Chris extension ${TARGET.extensionId}.`);
  } else if (!isUnavailable || !isSafePause) {
    errors.push(
      `Chris is not isolated from regular cadence: desiredAvailability=${desiredAvailability || "blank"}, pauseType=${pauseType || "blank"}, pauseReleaseAt=${pauseReleaseAt || "null"}.`,
    );
  }

  if (state.regularClashes.length > 0) {
    errors.push(`${state.regularClashes.length} active non-pilot/non-lane queue row(s) are still assigned to Chris.`);
  }

  if (state.laneItems.length > 0) {
    warnings.push(`${state.laneItems.length} active first-touch/appointment lane row(s) are already assigned to Chris.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function runChrisIsolationCheck(options) {
  printHeader("Chris regular-floor isolation gate");
  let state;
  try {
    state = await readChrisIsolationState();
  } finally {
    await disconnectMongo().catch(() => null);
  }

  const verdict = evaluateChrisIsolation(state);
  const routing = state.agentState?.cxRouting || {};
  console.log(JSON.stringify({
    agent: {
      email: TARGET.email,
      extensionId: TARGET.extensionId,
      activityState: state.agentState?.activityState || null,
      desiredAvailability: routing.desiredAvailability || null,
      pauseType: routing.pauseType || null,
      pauseReleaseAt: routing.pauseReleaseAt || null,
      lastSource: routing.lastSource || null,
      reason: routing.reason || null,
    },
    assignedActiveRows: {
      total: state.assignedItems.length,
      regularClash: state.regularClashes.length,
      lane: state.laneItems.length,
      pilot: state.pilotItems.length,
      breakdown: summarizeItems(state.assignedItems),
      regularClashSamples: state.regularClashes.slice(0, 5).map(itemSample),
    },
    verdict: verdict.ok ? "PASS" : "BLOCKED",
    warnings: verdict.warnings,
    errors: verdict.errors,
  }, null, 2));

  if (verdict.ok) {
    console.log("Isolation PASS: Chris has no active regular-floor rows and is held out of regular cadence.");
    return;
  }

  if (options.allowRegularClash) {
    console.log("Isolation BLOCKED but continuing because --allow-regular-clash was supplied.");
    return;
  }

  throw new Error("Chris regular-floor isolation gate failed. Put Chris in work-pause and clear/release regular assigned work before arming the canary.");
}

function buildChrisWorkPausePatch(now, actor = "cx-chris-canary") {
  return {
    activityState: "unavailable",
    lastActivityAt: now,
    lastStatusChange: now,
    "cxRouting.desiredAvailability": "unavailable",
    "cxRouting.reason": "manual-unavailable",
    "cxRouting.syncedAt": now,
    "cxRouting.lastSource": actor,
    "cxRouting.manualUnavailableAt": now,
    "cxRouting.pauseType": "work-pause",
    "cxRouting.pauseStartedAt": now,
    "cxRouting.pauseReleaseAt": null,
    "cxRouting.lastQueueReleaseAt": now,
    "upstream.source": actor,
    "upstream.mirroredAt": now,
  };
}

function summarizeReleaseResults(results) {
  const summary = new Map();
  for (const result of results) {
    const key = result?.mutated
      ? "released"
      : result?.ok === false
        ? `blocked:${result.reason || "unknown"}`
        : `skipped:${result?.reason || "unknown"}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  return Object.fromEntries(summary.entries());
}

async function applyChrisIsolation(options) {
  printHeader(`Chris isolation cleanup (${options.isolateApply ? "APPLY" : "dry-run"})`);
  const now = new Date();
  const actorEmail = "codex-chris-canary";
  let beforeState;
  let afterPauseState;
  let finalState;
  const releaseResults = [];
  try {
    beforeState = await readChrisIsolationState();
    const servingRows = beforeState.regularClashes.filter((item) => item.state === "serving");
    if (servingRows.length > 0 && !options.includeServing) {
      console.log(JSON.stringify({
        verdict: "BLOCKED",
        reason: "serving-rows-present",
        servingRows: servingRows.slice(0, 5).map(itemSample),
      }, null, 2));
      throw new Error("Chris has active serving regular rows. Re-run only after the live call is gone, or pass --include-serving deliberately.");
    }

    console.log(JSON.stringify({
      before: {
        agent: {
          desiredAvailability: beforeState.agentState?.cxRouting?.desiredAvailability || null,
          pauseType: beforeState.agentState?.cxRouting?.pauseType || null,
          pauseReleaseAt: beforeState.agentState?.cxRouting?.pauseReleaseAt || null,
        },
        assignedActiveRows: {
          total: beforeState.assignedItems.length,
          regularClash: beforeState.regularClashes.length,
          lane: beforeState.laneItems.length,
          pilot: beforeState.pilotItems.length,
          breakdown: summarizeItems(beforeState.assignedItems),
          regularClashSamples: beforeState.regularClashes.slice(0, 5).map(itemSample),
        },
      },
      dryRun: !options.isolateApply,
      plannedActions: [
        "set Chris AgentState to unavailable/work-pause with no release timer",
        `release ${beforeState.regularClashes.length} active regular-clash queue row(s) back to ready`,
      ],
    }, null, 2));

    if (!options.isolateApply) {
      console.log("Dry-run only. Add --isolate-apply or CX_CHRIS_CANARY_APPLY_ISOLATION=true to write this cleanup.");
      return;
    }

    if (!beforeState.agentState) {
      throw new Error(`No AgentState found for Chris extension ${TARGET.extensionId}; refusing to create one from the canary helper.`);
    }

    await agentStateRepository.updateAgentState(
      TARGET.extensionId,
      buildChrisWorkPausePatch(now, actorEmail),
    );

    afterPauseState = await readChrisIsolationState();
    for (const item of afterPauseState.regularClashes) {
      const result = await releaseCxQueueItem({
        queueItemId: item._id,
        now,
        releaseAt: now,
        reason: "chris-canary-isolation",
        actorEmail,
        extraUpdate: {
          metadata: {
            chrisCanaryIsolationReleasedAt: now,
            chrisCanaryIsolationReleasedBy: actorEmail,
            chrisCanaryIsolationPreviousClass: classifyAssignedQueueItem(item),
          },
        },
      });
      releaseResults.push({
        ...result,
        queueItemId: result?.queueItemId ? shortId(result.queueItemId) : null,
      });
    }

    finalState = await readChrisIsolationState();
    console.log(JSON.stringify({
      releaseSummary: summarizeReleaseResults(releaseResults),
      releaseSamples: releaseResults.slice(0, 5),
      after: {
        agent: {
          desiredAvailability: finalState.agentState?.cxRouting?.desiredAvailability || null,
          pauseType: finalState.agentState?.cxRouting?.pauseType || null,
          pauseReleaseAt: finalState.agentState?.cxRouting?.pauseReleaseAt || null,
        },
        assignedActiveRows: {
          total: finalState.assignedItems.length,
          regularClash: finalState.regularClashes.length,
          lane: finalState.laneItems.length,
          pilot: finalState.pilotItems.length,
          breakdown: summarizeItems(finalState.assignedItems),
        },
      },
    }, null, 2));

    const verdict = evaluateChrisIsolation(finalState);
    if (!verdict.ok) {
      throw new Error(`Chris isolation cleanup ran but gate is still blocked: ${verdict.errors.join(" ")}`);
    }
    console.log("Isolation cleanup PASS: Chris is held out of regular cadence and no regular-clash rows remain.");
  } finally {
    await disconnectMongo().catch(() => null);
  }
}

function buildQueueArgs(options) {
  const args = [
    path.join("scripts", "cx-pilot-queue.js"),
    "build-mix",
    "--agent", TARGET.email,
    "--domain", options.domain,
    "--count", String(options.count),
    "--mix", options.mix,
    "--tag", options.tag,
  ];
  if (options.cooldownDays) {
    args.push("--cooldown-days", String(options.cooldownDays));
  }
  if (options.queueArm) {
    args.push("--arm");
  }
  return args;
}

function runQueueBuild(options) {
  printHeader(`Chris pilot pool build (${options.queueArm ? "ARMED" : "dry-run"})`);
  const args = buildQueueArgs(options);
  console.log(`node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`cx-pilot-queue build failed with exit ${result.status}`);
  }
}

async function readRingcxState(client) {
  const dialGroup = await client.getDialGroup(TARGET.dialGroupId);
  const campaigns = [];
  for (const target of TARGET.campaigns) {
    const campaign = await client.getCampaign(target.campaignId, TARGET.dialGroupId);
    campaigns.push({ target, campaign });
  }
  return { dialGroup, campaigns };
}

function printRingcxState(state) {
  printHeader("RingCX current/desired priority state");
  console.log(JSON.stringify({
    dialGroup: {
      current: pick(state.dialGroup, [
        "dialGroupId",
        "dialGroupName",
        "enableAbsolutePriority",
        "enableListPriority",
        "dialMode",
        "isActive",
      ]),
      desired: {
        dialGroupId: TARGET.dialGroupId,
        enableAbsolutePriority: true,
      },
    },
    campaigns: state.campaigns.map(({ target, campaign }) => ({
      campaignId: target.campaignId,
      name: campaignName(campaign),
      current: pick(campaign, [
        "campaignId",
        "campaignName",
        "isActive",
        "campaignPriority",
        "dialLoadedOrder",
        "dispositionTimeout",
        "afterCallBaseState",
      ]),
      desired: {
        campaignPriority: target.priority,
      },
    })),
  }, null, 2));
}

function ringcxNeedsPatch(state) {
  if (state.dialGroup?.enableAbsolutePriority !== true) return true;
  return state.campaigns.some(({ target, campaign }) =>
    Number(campaign?.campaignPriority) !== Number(target.priority));
}

async function applyRingcxPriority(client, state, options) {
  printHeader(`RingCX priority finalizer (${options.applyRingcx ? "APPLY" : "dry-run"})`);
  if (!ringcxNeedsPatch(state)) {
    console.log("RingCX priority already matches the Chris combined canary target.");
    return;
  }

  if (state.dialGroup?.enableAbsolutePriority !== true) {
    console.log(`dial group ${TARGET.dialGroupId}: enableAbsolutePriority ${state.dialGroup?.enableAbsolutePriority} -> true`);
    if (options.applyRingcx) {
      await client.updateDialGroup(TARGET.dialGroupId, {
        ...state.dialGroup,
        enableAbsolutePriority: true,
      });
    }
  }

  for (const { target, campaign } of state.campaigns) {
    if (Number(campaign?.campaignPriority) === Number(target.priority)) continue;
    console.log(`campaign ${target.campaignId} (${target.label}): campaignPriority ${campaign?.campaignPriority} -> ${target.priority}`);
    if (options.applyRingcx) {
      await client.updateCampaign(target.campaignId, {
        ...campaign,
        campaignPriority: target.priority,
      }, TARGET.dialGroupId);
    }
  }

  if (!options.applyRingcx) {
    console.log("Dry-run only. Add --apply-ringcx or CX_CHRIS_CANARY_APPLY_RINGCX=true to write these settings.");
    return;
  }

  const verified = await readRingcxState(client);
  printHeader("RingCX read-back after apply");
  printRingcxState(verified);
  if (ringcxNeedsPatch(verified)) {
    throw new Error("RingCX priority read-back did not match desired Chris canary state.");
  }
}

function parseOptions(argv) {
  const isolateApply = hasFlag(argv, "--isolate-apply") || envBool("CX_CHRIS_CANARY_APPLY_ISOLATION", false);
  const queueArm = hasFlag(argv, "--queue-arm") || envBool("CX_CHRIS_CANARY_ARM_QUEUE", false);
  const applyRingcx = hasFlag(argv, "--apply-ringcx") || envBool("CX_CHRIS_CANARY_APPLY_RINGCX", false);
  const count = Number(readFlag(argv, "--count", "300"));
  return {
    help: hasFlag(argv, "--help") || hasFlag(argv, "-h"),
    isolateApply,
    isolateOnly: hasFlag(argv, "--isolate-only"),
    includeServing: hasFlag(argv, "--include-serving"),
    skipIsolation: hasFlag(argv, "--skip-isolation"),
    allowRegularClash: hasFlag(argv, "--allow-regular-clash"),
    skipQueue: hasFlag(argv, "--skip-queue"),
    skipRingcx: hasFlag(argv, "--skip-ringcx"),
    queueArm,
    applyRingcx,
    count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 300,
    mix: readFlag(argv, "--mix", "60/30/5/5"),
    cooldownDays: readFlag(argv, "--cooldown-days", ""),
    tag: readFlag(argv, "--tag", `pilot-cbolt-mix-${todayTag()}`),
    domain: String(readFlag(argv, "--domain", TARGET.domain)).trim().toUpperCase() || TARGET.domain,
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/cx-chris-combined-canary.js [options]

Default: dry-runs the Chris pilot pool build and RingCX priority patch.

Options:
  --isolate-only           Run only the Chris isolation check/cleanup, then exit
  --isolate-apply          Set Chris to work-pause and release regular-clash rows (same as CX_CHRIS_CANARY_APPLY_ISOLATION=true)
  --include-serving        Allow isolation cleanup to release serving rows too; default refuses
  --queue-arm              Actually arm the pilot pool build (same as CX_CHRIS_CANARY_ARM_QUEUE=true)
  --apply-ringcx           Apply RingCX priority settings LAST (same as CX_CHRIS_CANARY_APPLY_RINGCX=true)
  --skip-isolation         Skip the read-only Chris regular-floor isolation gate
  --allow-regular-clash    Print the isolation failure but continue anyway
  --skip-queue             Do not run the pilot pool builder
  --skip-ringcx            Do not read or patch RingCX priority settings
  --count N                Pilot pool size, default 300
  --mix SPEC               Pilot source mix, default 60/30/5/5
  --cooldown-days N        Forwarded to cx-pilot-queue.js build-mix
  --tag TAG                Build tag, default pilot-cbolt-mix-YYYYMMDD
  --domain DOMAIN          Default WYNN

Typical dry-run:
  node scripts/cx-chris-combined-canary.js

Build the queue but leave RingCX priority untouched:
  node scripts/cx-chris-combined-canary.js --queue-arm --skip-ringcx

Final priority flip after Mickey has env/restart/queue ready:
  node scripts/cx-chris-combined-canary.js --skip-queue --apply-ringcx

All-at-once finalizer (queue first, RingCX priority last):
  node scripts/cx-chris-combined-canary.js --queue-arm --apply-ringcx
`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  printHeader("Chris combined canary");
  console.log(`agent=${TARGET.email}`);
  console.log(`dialGroup=${TARGET.dialGroupId}`);
  console.log(`regular=${TARGET.campaigns[0].campaignId} firstTouch=${TARGET.campaigns[1].campaignId} appointment=${TARGET.campaigns[2].campaignId}`);
  console.log(`queue=${options.queueArm ? "ARMED" : "dry-run"} ringcx=${options.applyRingcx ? "APPLY" : "dry-run"}`);
  console.log("RingCX priority writes, if armed, run LAST.");

  printEnvPlan();

  if (options.isolateApply || options.isolateOnly) {
    await applyChrisIsolation(options);
    if (!options.isolateApply) {
      return;
    }
  }

  if (!options.skipIsolation) {
    await runChrisIsolationCheck(options);
  } else {
    printHeader("Chris regular-floor isolation gate");
    console.log("Skipped by --skip-isolation.");
  }

  if (options.isolateOnly) {
    return;
  }

  let ringcxState = null;
  let client = null;
  if (!options.skipRingcx) {
    client = createRingcxVoiceClient();
    ringcxState = await readRingcxState(client);
    printRingcxState(ringcxState);
  }

  if (!options.skipQueue) {
    runQueueBuild(options);
  }

  if (!options.skipRingcx) {
    await applyRingcxPriority(client, ringcxState, options);
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message || error}`);
  process.exitCode = 1;
});
