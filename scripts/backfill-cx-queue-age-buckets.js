"use strict";

const { getSharedConfig } = require("../packages/shared-config/src");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { CxDialQueue, LeadCadence } = require("../packages/shared-models/src");
const {
  deriveQueueFamilyFromLeadCreatedAt,
  getPacificBusinessDayAge,
  getQueueFamilySortRank,
} = require("../packages/shared-services/src/cxQueuePolicyService");

const ACTIVE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes("--apply"),
    limit: Number(argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1]) || 0,
  };
}

function keyFor(domain, caseId) {
  return `${String(domain || "").trim().toUpperCase()}:${Number(caseId)}`;
}

function pickLeadDate(item = {}, cadence = null) {
  const candidates = [
    item.leadCreatedAt,
    item.payloadSnapshot?.leadCreatedAt,
    item.payloadSnapshot?.createdAt,
    item.metadata?.leadCreatedAt,
    cadence?.createdAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function getPlacedCalls(item = {}) {
  const value = item.placedCalls ?? item.metadata?.placedCalls ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.trunc(number), 0) : 0;
}

function progressiveStageFor(nextFamily, ageDays, placedCalls) {
  if (nextFamily === "fresh-day1") {
    const stageIndex = Math.min(Math.max(placedCalls, 0), 2);
    if (stageIndex >= 2) {
      return {
        progressiveStageKey: "third-contact",
        progressiveStageIndex: 2,
        progressiveStageLabel: "Third contact",
      };
    }
    if (stageIndex >= 1) {
      return {
        progressiveStageKey: "second-contact",
        progressiveStageIndex: 1,
        progressiveStageLabel: "Second contact",
      };
    }
    return {
      progressiveStageKey: "just-came-in",
      progressiveStageIndex: 0,
      progressiveStageLabel: "Just came in",
    };
  }
  if (nextFamily === "fresh-day2to10") {
    return {
      progressiveStageKey: "day2to15",
      progressiveStageIndex: Math.max(Number(ageDays) + 1 || 3, 3),
      progressiveStageLabel: "3-15",
    };
  }
  if (nextFamily === "fresh-day16to30") {
    return {
      progressiveStageKey: "day16to30",
      progressiveStageIndex: Math.max(Number(ageDays) + 1 || 16, 16),
      progressiveStageLabel: "16-30",
    };
  }
  if (nextFamily === "aged") {
    return {
      progressiveStageKey: "aged-cadence",
      progressiveStageIndex: 99,
      progressiveStageLabel: "31-120",
    };
  }
  if (nextFamily === "dead") {
    return {
      progressiveStageKey: "dead",
      progressiveStageIndex: 999,
      progressiveStageLabel: "Dead",
    };
  }
  return {
    progressiveStageKey: null,
    progressiveStageIndex: 99,
    progressiveStageLabel: null,
  };
}

async function loadCadenceMap(items) {
  const pairs = Array.from(
    new Map(
      items
        .filter((item) => item?.domain && Number.isFinite(Number(item?.caseId)))
        .map((item) => [keyFor(item.domain, item.caseId), { domain: item.domain, caseId: Number(item.caseId) }]),
    ).values(),
  );
  const cadenceMap = new Map();
  for (let offset = 0; offset < pairs.length; offset += 500) {
    const chunk = pairs.slice(offset, offset + 500);
    const rows = chunk.length
      ? await LeadCadence.find(
          { $or: chunk.map((pair) => ({ domain: pair.domain, caseId: pair.caseId })) },
          { domain: 1, caseId: 1, createdAt: 1 },
        ).lean()
      : [];
    for (const row of rows) cadenceMap.set(keyFor(row.domain, row.caseId), row);
  }
  return cadenceMap;
}

async function main() {
  const args = parseArgs();
  await connectMongo(getSharedConfig());
  const query = { state: { $in: ACTIVE_STATES } };
  const read = CxDialQueue.find(query).sort({ queueFamily: 1, createdAt: 1 });
  if (args.limit > 0) read.limit(args.limit);
  const items = await read.lean();
  const cadenceMap = await loadCadenceMap(items);
  const now = new Date();
  const ops = [];
  const counts = {};
  const examples = [];
  let skippedNoDate = 0;

  for (const item of items) {
    const cadence = cadenceMap.get(keyFor(item.domain, item.caseId));
    const leadDate = pickLeadDate(item, cadence);
    if (!leadDate) {
      skippedNoDate += 1;
      continue;
    }
    const placedCalls = getPlacedCalls(item);
    const nextFamily = deriveQueueFamilyFromLeadCreatedAt(leadDate, now, { placedCalls });
    const oldFamily = String(item.queueFamily || "unassigned");
    const key = `${oldFamily}=>${nextFamily}`;
    counts[key] = Number(counts[key] || 0) + 1;
    if (oldFamily === nextFamily) continue;

    const ageDays = getPacificBusinessDayAge(leadDate, now);
    const stage = progressiveStageFor(nextFamily, ageDays, placedCalls);
    const set = {
      queueFamily: nextFamily,
      queueFamilyRank: getQueueFamilySortRank(nextFamily),
      progressiveStageKey: stage.progressiveStageKey,
      progressiveStageIndex: stage.progressiveStageIndex,
      progressiveStageLabel: stage.progressiveStageLabel,
      "metadata.queueFamily": nextFamily,
      "metadata.queueFamilyRank": getQueueFamilySortRank(nextFamily),
      "metadata.progressiveStageKey": stage.progressiveStageKey,
      "metadata.progressiveStageIndex": stage.progressiveStageIndex,
      "metadata.progressiveStageLabel": stage.progressiveStageLabel,
      "metadata.ageBucketBackfilledAt": now,
      "metadata.ageBucketBackfilledFrom": oldFamily,
    };
    if (item.callPlan && typeof item.callPlan === "object") {
      set.callPlan = {
        ...item.callPlan,
        activeDay: Number.isFinite(Number(ageDays)) ? Number(ageDays) + 1 : item.callPlan.activeDay,
      };
    }
    if (nextFamily === "dead") {
      set.state = "cancelled";
      set.cancelledAt = now;
      set.cancelReason = "dead-age-bucket";
      set["metadata.deadCancelledAt"] = now;
    }
    ops.push({
      updateOne: {
        filter: { _id: item._id },
        update: { $set: set },
      },
    });
    if (examples.length < 20) {
      examples.push({
        id: String(item._id),
        caseId: item.caseId,
        state: item.state,
        oldFamily,
        nextFamily,
        leadDate,
        placedCalls,
      });
    }
  }

  let writeResult = null;
  if (args.apply && ops.length > 0) {
    writeResult = await CxDialQueue.bulkWrite(ops, { ordered: false });
  }

  console.log(JSON.stringify({
    apply: args.apply,
    scanned: items.length,
    skippedNoDate,
    changed: ops.length,
    counts,
    examples,
    writeResult,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo().catch(() => null);
  });
