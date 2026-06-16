"use strict";

const mongoose = require("mongoose");
const MetricClose = require("../../shared-models/src/MetricClose");

// The cross-tenant reconciliation collection the one-off script writes
// (scripts/reconcile-monthly-call-totals.js). No model — read the raw collection.
const RECONCILIATION_COLLECTION = "controlplanemetriccallreconciliations";

// Latest reconciliation doc for the current month (max toKey for this month's
// fromKey). Returns null when none exists or the connection isn't ready.
async function findCurrentMonthReconciliation({ periodKey } = {}) {
  const key = String(periodKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(key)) return null;
  const db = mongoose.connection && mongoose.connection.db;
  if (!db) return null;
  const docs = await db
    .collection(RECONCILIATION_COLLECTION)
    .find({ kind: "monthly-call-honesty", "range.fromKey": `${key}-01` })
    .sort({ "range.toKey": -1 })
    .limit(1)
    .toArray();
  return docs[0] || null;
}

// Write-once freeze. NEVER mutates an existing row (immutability via $setOnInsert)
// and NEVER writes a live snapshot once the period already has a final close.
async function freezeClose(record) {
  if (!record || !record.periodKey || !record.asOfDateKey) {
    return { skipped: true, reason: "no-record" };
  }
  const scope = record.scope || "all";
  const grain = record.grain || "month";

  const existingFinal = await MetricClose.findOne({
    scope,
    grain,
    periodKey: record.periodKey,
    status: "final",
  }).lean();
  if (existingFinal) {
    return { skipped: true, reason: "period-final", close: existingFinal };
  }

  const filter = { scope, grain, periodKey: record.periodKey, asOfDateKey: record.asOfDateKey };
  const before = await MetricClose.findOne(filter).lean();
  const close = await MetricClose.findOneAndUpdate(
    filter,
    { $setOnInsert: record },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return before
    ? { skipped: true, reason: "already-frozen", close }
    : { frozen: true, close };
}

async function findFinalClose(scope, grain, periodKey) {
  return MetricClose.findOne({ scope, grain, periodKey, status: "final" }).lean();
}

// What the dashboard reads for a period: the final close if the month is closed,
// otherwise the most recent (live) as-of snapshot.
async function findLatestClose(scope, grain, periodKey) {
  const final = await findFinalClose(scope, grain, periodKey);
  if (final) return final;
  return MetricClose.findOne({ scope, grain, periodKey })
    .sort({ asOfDateKey: -1, recordedAt: -1 })
    .lean();
}

async function listClosesForPeriod(scope, grain, periodKey) {
  return MetricClose.find({ scope, grain, periodKey }).sort({ asOfDateKey: 1 }).lean();
}

module.exports = {
  findCurrentMonthReconciliation,
  freezeClose,
  findFinalClose,
  findLatestClose,
  listClosesForPeriod,
};
