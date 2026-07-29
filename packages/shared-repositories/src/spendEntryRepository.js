"use strict";

const crypto = require("crypto");
const { SpendEntry } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildDateRangeQuery(filters = {}) {
  if (!filters.from && !filters.to && !filters.date) return {};
  if (filters.date) return { date: String(filters.date) };

  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  return { date: range };
}

async function listSpendEntries(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    active: { $ne: false },
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;
  if (filters.source) query.source = filters.source;
  if (filters.sheetId) query.sheetId = filters.sheetId;

  const limit = Math.min(Number(filters.limit) || 100, 500);
  return SpendEntry.find(query)
    .sort({ date: -1, updatedAt: -1 })
    .limit(limit)
    .lean();
}

async function summarizeSpendBySource(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    active: { $ne: false },
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;

  return SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: { source: "$source", channel: "$channel" },
        spend: { $sum: "$spend" },
        pieces: { $sum: "$pieces" },
        impressions: { $sum: "$impressions" },
        clicks: { $sum: "$clicks" },
        leadsReported: { $sum: "$leadsReported" },
        rows: { $sum: 1 },
      },
    },
    { $sort: { spend: -1, "_id.source": 1 } },
  ]);
}

async function summarizeMailCosts(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    channel: "mailer",
    active: { $ne: false },
    ...buildDateRangeQuery(filters),
  };

  return SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: { source: "$source", phone: "$phone" },
        totalSpend: { $sum: "$spend" },
        totalPieces: { $sum: "$pieces" },
        drops: { $sum: 1 },
        firstDate: { $min: "$date" },
        lastDate: { $max: "$date" },
      },
    },
    { $sort: { totalSpend: -1 } },
  ]);
}

async function getSpendTotals(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    active: { $ne: false },
    ...buildDateRangeQuery(filters),
  };

  if (filters.channel) query.channel = filters.channel;

  const [row] = await SpendEntry.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        spend: { $sum: "$spend" },
        pieces: { $sum: "$pieces" },
        impressions: { $sum: "$impressions" },
        clicks: { $sum: "$clicks" },
        leadsReported: { $sum: "$leadsReported" },
        rows: { $sum: 1 },
      },
    },
  ]);

  return row || {
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leadsReported: 0,
    rows: 0,
  };
}

function buildSpendEntryIdentity(entry = {}) {
  const identity = {
    date: String(entry.date || ""),
    domain: normalizeDomain(entry.domain),
    channel: String(entry.channel || "").trim(),
    sheetId: entry.sheetId || null,
  };

  if (entry.broadcastId) {
    identity.broadcastId = String(entry.broadcastId);
  } else if (entry.jobNumber) {
    identity.jobNumber = String(entry.jobNumber);
  } else if (entry.metaAdId) {
    identity.metaAdId = String(entry.metaAdId);
  } else if (entry.adName || entry.adSet) {
    identity.campaign = String(entry.campaign || "");
    identity.adSet = String(entry.adSet || "");
    identity.adName = String(entry.adName || "");
  } else if (entry.campaign) {
    identity.campaign = String(entry.campaign);
  } else {
    identity.source = String(entry.source || "");
  }

  return identity;
}

function buildSpendEntryKey(entry = {}) {
  const identity = buildSpendEntryIdentity(entry);
  const canonical = Object.keys(identity)
    .sort()
    .map((key) => `${key}=${identity[key] == null ? "" : String(identity[key]).trim()}`)
    .join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function upsertSpendEntry(entry = {}) {
  const identity = buildSpendEntryIdentity(entry);
  const entryKey = entry.entryKey || buildSpendEntryKey(entry);
  return SpendEntry.findOneAndUpdate(
    { $or: [{ entryKey }, identity] },
    { $set: {
      ...entry,
      entryKey,
      active: true,
      factOwner: "marketing-money",
      retiredAt: null,
      domain: normalizeDomain(entry.domain),
      syncedAt: entry.syncedAt || new Date(),
    } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function upsertSpendEntries(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const operations = entries.map((entry) => ({
    updateOne: {
      filter: { $or: [
        { entryKey: entry.entryKey || buildSpendEntryKey(entry) },
        buildSpendEntryIdentity(entry),
      ] },
      update: {
        $set: {
          ...entry,
          entryKey: entry.entryKey || buildSpendEntryKey(entry),
          active: true,
          factOwner: "marketing-money",
          retiredAt: null,
          domain: normalizeDomain(entry.domain),
          syncedAt: entry.syncedAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  return SpendEntry.bulkWrite(operations, { ordered: false });
}

async function reconcileSpendEntries(entries = [], scope = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const domain = normalizeDomain(scope.domain || rows[0]?.domain);
  const channel = String(scope.channel || rows[0]?.channel || "").trim();
  const sheetId = scope.sheetId || rows[0]?.sheetId || null;
  const runId = String(scope.runId || `spend-${Date.now()}`);
  if (!domain || !channel || !sheetId) {
    throw new Error("reconcileSpendEntries requires domain, channel, and sheetId");
  }
  if (rows.length === 0 && scope.allowEmpty !== true) {
    throw new Error("reconcileSpendEntries refuses to retire a source from an empty result");
  }

  const stamped = rows.map((row) => ({
    ...row,
    domain,
    channel,
    sheetId,
    entryKey: buildSpendEntryKey({ ...row, domain, channel, sheetId }),
    reconciliationRunId: runId,
  }));
  const writeResult = await upsertSpendEntries(stamped);
  const activeKeys = stamped.map((row) => row.entryKey);
  const retireResult = await SpendEntry.updateMany(
    {
      domain,
      channel,
      sheetId,
      active: { $ne: false },
      reconciliationRunId: { $ne: runId },
      ...(activeKeys.length ? { entryKey: { $nin: activeKeys } } : {}),
    },
    { $set: { active: false, retiredAt: new Date(), reconciliationRunId: runId } },
  );
  return {
    matchedCount: Number(writeResult.matchedCount || 0),
    modifiedCount: Number(writeResult.modifiedCount || 0),
    upsertedCount: Number(writeResult.upsertedCount || 0),
    retiredCount: Number(retireResult.modifiedCount || 0),
    runId,
  };
}

// Atomic per-event INCREMENT of a spend row (real-time LD-lead tick). Adds spend / leadsReported
// to the (date, domain, channel, campaign) identity, creating the row on first hit. The `onInsert`
// fields (source, costPerLead, raw) stamp the row's metadata on creation only. Tag the row with
// raw.computedBy = "ld-spend-materializer" so the nightly materializer RECONCILES it
// (recompute-and-SET) rather than treating it as an operator manual nudge.
async function incrementSpendEntry(identity = {}, deltas = {}, onInsert = {}) {
  const filter = buildSpendEntryIdentity(identity);
  const inc = {};
  if (Number.isFinite(Number(deltas.spend))) inc.spend = Number(deltas.spend);
  if (Number.isFinite(Number(deltas.leadsReported))) inc.leadsReported = Number(deltas.leadsReported);
  const update = {
    $setOnInsert: { ...filter, ...onInsert },
    $set: { syncedAt: new Date() },
  };
  if (Object.keys(inc).length) update.$inc = inc;
  return SpendEntry.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true });
}

module.exports = {
  buildSpendEntryKey,
  buildSpendEntryIdentity,
  getSpendTotals,
  incrementSpendEntry,
  listSpendEntries,
  reconcileSpendEntries,
  summarizeMailCosts,
  summarizeSpendBySource,
  upsertSpendEntries,
  upsertSpendEntry,
};
