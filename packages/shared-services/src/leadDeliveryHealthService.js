"use strict";

const {
  DailyDial,
  LeadDeliveryItem,
} = require("../../shared-models/src");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const ORDINARY_POOLS = Object.freeze([
  "new_today",
  "overnight",
  "older_available",
  "follow_up_due",
]);
const OPEN_STATES = Object.freeze([
  "eligible",
  "reserved",
  "packetized",
  "provider_accepted",
  "in_call",
  "follow_up_wait",
  "delivery_failed",
]);
const DUE_STATES = Object.freeze(["eligible", "follow_up_wait", "delivery_failed"]);

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function bandQuery(band) {
  if (band === "zeroTouch") return { totalAttemptCount: 0, lastContactAt: null };
  if (band === "lowTouch") {
    return {
      $or: [
        { totalAttemptCount: { $gte: 1, $lt: 10 } },
        { totalAttemptCount: 0, lastContactAt: { $ne: null } },
      ],
    };
  }
  if (band === "highTouch") return { totalAttemptCount: { $gte: 10, $lt: 15 } };
  if (band === "phaseOut") return { totalAttemptCount: { $gte: 15 } };
  throw new TypeError("band must be zeroTouch, lowTouch, highTouch, or phaseOut");
}

function mergeQuery(...parts) {
  const filtered = parts.filter(Boolean);
  return filtered.length === 1 ? filtered[0] : { $and: filtered };
}

async function boundedCount(model, query, maxTimeMS) {
  const pending = model.countDocuments(query);
  if (pending && typeof pending.maxTimeMS === "function") return pending.maxTimeMS(maxTimeMS);
  return pending;
}

function normalizeAttemptCounts(row = {}) {
  return {
    total: count(row.total),
    firstTouches: count(row.firstTouches),
    lowTouch: count(row.lowTouch),
    highTouch: count(row.highTouch),
    phaseOut: count(row.phaseOut),
  };
}

function deriveLeadHealthAlerts({ inventory, attempts }) {
  const staleZeroTouch = inventory.zeroTouchOlderThanToday > 0;
  const zeroTouchDue = inventory.due.zeroTouch > 0;
  const lightWorkBacklog = inventory.due.lowTouch > 0;
  const highTouchWhileLightDue = lightWorkBacklog
    && (attempts.highTouch + attempts.phaseOut) > 0;
  const noCallsWithOpenWork = attempts.total === 0
    && (inventory.due.zeroTouch + inventory.due.lowTouch) > 0;
  return {
    staleZeroTouch,
    zeroTouchDue,
    lightWorkBacklog,
    highTouchWhileLightDue,
    noCallsWithOpenWork,
    attention: staleZeroTouch || zeroTouchDue || highTouchWhileLightDue || noCallsWithOpenWork,
  };
}

async function gatherLeadDeliveryHealth({
  dateKey,
  at = new Date(),
  itemModel = LeadDeliveryItem,
  dailyDialModel = DailyDial,
  maxTimeMS = 10_000,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    throw new TypeError("dateKey must be YYYY-MM-DD");
  }
  const now = new Date(at);
  if (Number.isNaN(now.getTime())) throw new TypeError("at must be a valid date");
  const { start } = buildTimezoneDateWindow(dateKey, PACIFIC_TIME_ZONE);
  const openBase = {
    sourcePool: { $in: ORDINARY_POOLS },
    state: { $in: OPEN_STATES },
    inventoryClass: { $ne: "callrail_long_call_recovery" },
  };
  const dueBase = {
    ...openBase,
    state: { $in: DUE_STATES },
    $or: [
      { nextContactAt: null },
      { nextContactAt: { $lte: now } },
    ],
  };

  const bands = ["zeroTouch", "lowTouch", "highTouch", "phaseOut"];
  const inventoryQueries = [
    ...bands.map((band) => mergeQuery(openBase, bandQuery(band))),
    ...bands.map((band) => mergeQuery(dueBase, bandQuery(band))),
    mergeQuery(openBase, bandQuery("zeroTouch"), { receivedAt: { $lt: start } }),
    mergeQuery(openBase, bandQuery("zeroTouch"), {
        state: { $in: ["provider_accepted", "in_call"] },
      }),
    {
      sourcePool: { $in: ORDINARY_POOLS },
      state: "review",
      inventoryClass: { $ne: "callrail_long_call_recovery" },
    },
  ];
  // Keep the nightly observer gentle. The counts share one covered index, but
  // launching every band concurrently would still manufacture a needless
  // compute spike at close.
  const inventoryCounts = [];
  for (const query of inventoryQueries) {
    inventoryCounts.push(await boundedCount(itemModel, query, maxTimeMS));
  }

  const attemptsRows = await dailyDialModel.aggregate([
    { $match: { dateKey } },
    { $unwind: "$attempts" },
    { $match: { "attempts.provider": "phoneburner" } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        firstTouches: { $sum: { $cond: [{ $eq: ["$attempts.totalAttemptCount", 1] }, 1, 0] } },
        lowTouch: {
          $sum: {
            $cond: [{
              $and: [
                { $gte: ["$attempts.totalAttemptCount", 2] },
                { $lt: ["$attempts.totalAttemptCount", 10] },
              ],
            }, 1, 0],
          },
        },
        highTouch: {
          $sum: {
            $cond: [{
              $and: [
                { $gte: ["$attempts.totalAttemptCount", 10] },
                { $lt: ["$attempts.totalAttemptCount", 15] },
              ],
            }, 1, 0],
          },
        },
        phaseOut: { $sum: { $cond: [{ $gte: ["$attempts.totalAttemptCount", 15] }, 1, 0] } },
      },
    },
    { $project: { _id: 0 } },
  ]).option({ maxTimeMS });

  const inventory = {
    zeroTouch: count(inventoryCounts[0]),
    lowTouch: count(inventoryCounts[1]),
    highTouch: count(inventoryCounts[2]),
    phaseOut: count(inventoryCounts[3]),
    due: {
      zeroTouch: count(inventoryCounts[4]),
      lowTouch: count(inventoryCounts[5]),
      highTouch: count(inventoryCounts[6]),
      phaseOut: count(inventoryCounts[7]),
    },
    zeroTouchOlderThanToday: count(inventoryCounts[8]),
    zeroTouchProviderHeld: count(inventoryCounts[9]),
    review: count(inventoryCounts[10]),
  };
  inventory.total = inventory.zeroTouch + inventory.lowTouch
    + inventory.highTouch + inventory.phaseOut;
  const attempts = normalizeAttemptCounts(attemptsRows[0]);
  return {
    dateKey,
    inventory,
    attempts,
    alerts: deriveLeadHealthAlerts({ inventory, attempts }),
  };
}

module.exports = {
  bandQuery,
  deriveLeadHealthAlerts,
  gatherLeadDeliveryHealth,
  normalizeAttemptCounts,
};
