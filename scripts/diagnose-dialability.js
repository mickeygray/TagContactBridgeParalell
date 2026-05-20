"use strict";
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue } = require("../packages/shared-models/src");
const { resolveQueueDialability, getPacificDateKey } = require("../packages/shared-services/src/cxQueuePolicyService");

(async () => {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const now = new Date();

  // Pull every ready CxDialQueue item and simulate dialability.
  const ready = await CxDialQueue.find(
    { state: "ready" },
    {
      domain: 1, queueFamily: 1, queueFamilyRank: 1,
      dailyPlacedDateKey: 1, dailyPlacedCalls: 1,
      hourlyPlacedHourKey: 1, hourlyPlacedCalls: 1,
      lastPlacedAt: 1, releaseAt: 1,
      cooldownReleaseAt: 1, claimUntil: 1,
      caseId: 1, createdAt: 1, metadata: 1,
    },
  ).lean();
  console.log(`Total ready: ${ready.length}`);

  const buckets = {};
  const reasons = {};
  for (const item of ready) {
    const dialability = resolveQueueDialability(item, now);
    const family = item.queueFamily || "unknown";
    const key = family;
    if (!buckets[key]) buckets[key] = { dialable: 0, blocked: 0, total: 0 };
    buckets[key].total++;
    if (dialability.ok || dialability.dialable) {
      buckets[key].dialable++;
    } else {
      buckets[key].blocked++;
      const reasonKey = `${family}:${dialability.reason || "unknown"}`;
      reasons[reasonKey] = (reasons[reasonKey] || 0) + 1;
    }
  }

  console.log("\n=== Dialability of ready items by family ===");
  console.log(`  family                  total  dialable  blocked`);
  for (const [family, b] of Object.entries(buckets).sort()) {
    console.log(`  ${family.padEnd(22)} ${String(b.total).padStart(5)}   ${String(b.dialable).padStart(7)}   ${String(b.blocked).padStart(6)}`);
  }

  console.log("\n=== Why ready items are blocked ===");
  for (const [key, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(50)} ${count}`);
  }

  // What does today's per-day daily-cap usage look like across ready items?
  const todayKey = getPacificDateKey(now);
  console.log(`\n=== Today's dailyPlacedCalls distribution on ready items (dateKey=${todayKey}) ===`);
  const dailyDist = {};
  for (const item of ready) {
    const itemKey = String(item.dailyPlacedDateKey || item.metadata?.dailyPlacedDateKey || "");
    const isToday = itemKey === todayKey;
    const family = item.queueFamily || "unknown";
    const count = isToday ? (Number(item.dailyPlacedCalls) || 0) : 0;
    const bucket = `${family}:${count}`;
    dailyDist[bucket] = (dailyDist[bucket] || 0) + 1;
  }
  for (const [k, v] of Object.entries(dailyDist).sort()) {
    console.log(`  ${k.padEnd(35)} ${v}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
