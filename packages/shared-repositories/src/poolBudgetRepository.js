"use strict";

const { PoolBudget } = require("../../shared-models/src");

const SINGLETON_KEY = "global";

async function readBudget() {
  const existing = await PoolBudget.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (existing) return existing;
  const created = await PoolBudget.create({ singletonKey: SINGLETON_KEY });
  return created.toObject();
}

async function recordRefill({ floor, addedCount, hourBucket }) {
  return PoolBudget.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    {
      $set: {
        lastRefilledAt: new Date(),
        lastRefilledFloor: floor,
        hourBucket,
      },
      $inc: {
        hourEnteredCount: addedCount,
        hourRefilledCount: 1,
      },
    },
    { new: true, upsert: true, lean: true },
  );
}

async function recordEmptied() {
  return PoolBudget.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    { $set: { lastEmptiedAt: new Date(), inPoolCount: 0 } },
    { new: true, upsert: true, lean: true },
  );
}

async function snapshotOccupancy({
  inPoolCount,
  inPoolByPartition,
  inPoolByAgeBucket,
}) {
  return PoolBudget.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    {
      $set: {
        inPoolCount,
        inPoolByPartition,
        inPoolByAgeBucket,
      },
    },
    { new: true, upsert: true, lean: true },
  );
}

async function incrementCompleted(count = 1) {
  return PoolBudget.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    { $inc: { hourCompletedCount: count } },
    { new: true, upsert: true, lean: true },
  );
}

async function rolloverHour(newHourBucket) {
  // Capture prior counters then reset for new hour. Returns the prior
  // values so the orchestrator can write them into PacingReport before
  // the reset takes effect.
  const prior = await PoolBudget.findOne({ singletonKey: SINGLETON_KEY }).lean();
  await PoolBudget.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    {
      $set: {
        hourBucket: newHourBucket,
        hourEnteredCount: 0,
        hourCompletedCount: 0,
        hourRefilledCount: 0,
      },
    },
    { upsert: true },
  );
  return prior || null;
}

module.exports = {
  readBudget,
  recordRefill,
  recordEmptied,
  snapshotOccupancy,
  incrementCompleted,
  rolloverHour,
};
