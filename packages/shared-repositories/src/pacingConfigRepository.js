"use strict";

const { PacingConfig } = require("../../shared-models/src");

const SINGLETON_KEY = "global";

async function readConfig() {
  const existing = await PacingConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (existing) return existing;
  const created = await PacingConfig.create({ singletonKey: SINGLETON_KEY });
  return created.toObject();
}

async function updateConfig(patch, { updatedBy = "system" } = {}) {
  // Build audit history entries by diffing. Caller should pass only
  // the fields they intend to change. Skips history for `history` /
  // `lastUpdatedBy` themselves.
  const current = await readConfig();
  const auditEntries = [];
  for (const [field, newValue] of Object.entries(patch || {})) {
    if (field === "history" || field === "lastUpdatedBy" || field === "singletonKey") continue;
    const previousValue = current[field];
    if (JSON.stringify(previousValue) === JSON.stringify(newValue)) continue;
    auditEntries.push({
      field,
      previousValue,
      newValue,
      updatedBy,
      updatedAt: new Date(),
    });
  }

  const update = {
    $set: { ...patch, lastUpdatedBy: updatedBy },
  };
  if (auditEntries.length) {
    update.$push = { history: { $each: auditEntries } };
  }

  return PacingConfig.findOneAndUpdate(
    { singletonKey: SINGLETON_KEY },
    update,
    { new: true, upsert: true, lean: true },
  );
}

async function getHistory({ limit = 100 } = {}) {
  const config = await readConfig();
  const history = Array.isArray(config.history) ? config.history : [];
  return history
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

module.exports = {
  readConfig,
  updateConfig,
  getHistory,
};
