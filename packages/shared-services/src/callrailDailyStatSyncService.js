"use strict";

// CallRail -> DailyCallStat: the single owner of inbound-response facts.
// A run is a complete source-image recompute for an explicit closed range.
// Validation completes before Mongo is read, and writes are changed-only.

const DailyCallStat = require("../../shared-models/src/DailyCallStat");
const { createCallrailClient } = require("../../shared-integrations/src/callrailClient");

const DIRECT_SOURCE = "callrail-direct";
const RETIRED_REASON = "absent-from-complete-callrail-recompute";
const SYNC_FIELDS = [
  "id",
  "customer_phone_number",
  "tracking_phone_number",
  "source",
  "source_name",
  "start_time",
  "duration",
  "direction",
  "first_call",
];

function syncError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireDateKey(value, name) {
  const dateKey = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw syncError("CALLRAIL_INVALID_RANGE", `${name} must use YYYY-MM-DD`);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.toISOString().slice(0, 10) !== dateKey) {
    throw syncError("CALLRAIL_INVALID_RANGE", `${name} is not a calendar date`);
  }
  return dateKey;
}

function validateRange(from, to) {
  const first = requireDateKey(from, "from");
  const last = requireDateKey(to, "to");
  if (first > last) throw syncError("CALLRAIL_INVALID_RANGE", "from must not be after to");
  return { from: first, to: last };
}

function laDateOf(startTime) {
  const value = String(startTime || "");
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function pieceOf(call) {
  const name = String(call.source_name || call.source || "").trim();
  if (name) return name;
  const tracking = String(call.tracking_phone_number || "").trim();
  return tracking ? `Unmapped ${tracking}` : "Unknown";
}

function assertCompletePayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.calls)) {
    throw syncError("CALLRAIL_INVALID_SOURCE_IMAGE", "CallRail response did not contain calls[]");
  }
  if (payload.truncated === true) {
    throw syncError("CALLRAIL_SOURCE_TRUNCATED", "CallRail source image was truncated");
  }
  const total = Number(payload.total_records);
  if (!Number.isInteger(total) || total < 0 || total !== payload.calls.length) {
    throw syncError(
      "CALLRAIL_SOURCE_COUNT_MISMATCH",
      "CallRail total_records did not equal the complete calls[] length",
    );
  }
  return payload.calls;
}

function groupCalls(calls, { from, to }) {
  const seenIds = new Set();
  const groups = new Map();
  for (const call of calls) {
    const id = String(call?.id || "").trim();
    if (!id) throw syncError("CALLRAIL_MISSING_IDENTITY", "CallRail call was missing id");
    if (seenIds.has(id)) {
      throw syncError("CALLRAIL_DUPLICATE_IDENTITY", "CallRail source image repeated a call id");
    }
    seenIds.add(id);
    const date = laDateOf(call.start_time);
    if (!date || date < from || date > to) {
      throw syncError("CALLRAIL_OUT_OF_RANGE_CALL", "CallRail call date was invalid or out of range");
    }
    if (String(call.direction || "").trim().toLowerCase() !== "inbound") {
      throw syncError("CALLRAIL_NON_INBOUND_CALL", "CallRail source image included a non-inbound call");
    }
    const duration = Number(call.duration);
    if (!Number.isFinite(duration) || duration < 0) {
      throw syncError("CALLRAIL_INVALID_DURATION", "CallRail call duration was invalid");
    }
    if (typeof call.first_call !== "boolean") {
      throw syncError("CALLRAIL_INVALID_FIRST_CALL", "CallRail first_call was not boolean");
    }
    const piece = pieceOf(call);
    const key = `${date}\u0000${piece}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        date,
        piece,
        trackingNumber: String(call.tracking_phone_number || "").trim() || null,
        totalCalls: 0,
        firstTimeCallers: 0,
        callsOver2: 0,
        callsOver5: 0,
        totalDuration: 0,
        callers: new Set(),
        firstCallTime: null,
        lastCallTime: null,
      };
      groups.set(key, group);
    }

    group.totalCalls += 1;
    if (call.first_call === true) group.firstTimeCallers += 1;
    if (duration >= 120) group.callsOver2 += 1;
    if (duration >= 300) group.callsOver5 += 1;
    group.totalDuration += duration;
    if (call.customer_phone_number) group.callers.add(String(call.customer_phone_number));
    const time = String(call.start_time || "");
    if (!group.firstCallTime || time < group.firstCallTime) group.firstCallTime = time;
    if (!group.lastCallTime || time > group.lastCallTime) group.lastCallTime = time;
  }
  return groups;
}

function groupKey(value) {
  return `${String(value.date)}\u0000${String(value.piece)}`;
}

function directDocument(group) {
  return {
    date: group.date,
    piece: group.piece,
    channel: "mailer",
    syncSource: DIRECT_SOURCE,
    active: true,
    retiredAt: null,
    retiredReason: null,
    trackingNumber: group.trackingNumber,
    totalCalls: group.totalCalls,
    firstTimeCallers: group.firstTimeCallers,
    callsOver2: group.callsOver2,
    callsOver5: group.callsOver5,
    totalDuration: group.totalDuration,
    avgDuration: group.totalCalls > 0 ? Math.round(group.totalDuration / group.totalCalls) : 0,
    uniqueCallers: group.callers.size,
    firstCallTime: group.firstCallTime,
    lastCallTime: group.lastCallTime,
    raw: null,
  };
}

const COMPARE_FIELDS = [
  "date", "piece", "channel", "syncSource", "active", "retiredAt", "retiredReason",
  "trackingNumber", "totalCalls", "firstTimeCallers", "callsOver2", "callsOver5",
  "totalDuration", "avgDuration", "uniqueCallers", "firstCallTime", "lastCallTime", "raw",
];

function comparable(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function sameDirectFields(existing, next) {
  return COMPARE_FIELDS.every((field) => (
    JSON.stringify(comparable(existing?.[field])) === JSON.stringify(comparable(next?.[field]))
  ));
}

function createCallrailDailyStatSync({
  DailyCallStatModel = DailyCallStat,
  createClient = createCallrailClient,
  now = () => new Date(),
} = {}) {
  return async function syncCallrailDailyStats({
    from,
    to,
    companyKey = "TAG",
    dryRun = false,
  } = {}) {
    const range = validateRange(from, to);
    const client = createClient(companyKey);
    const payload = await client.listInboundCallsForRange({
      startDate: range.from,
      endDate: range.to,
      fields: SYNC_FIELDS,
      order: "asc",
    });
    const calls = assertCompletePayload(payload);
    const groups = groupCalls(calls, range);

    // No Mongo access occurs until the complete source image is proven.
    const existing = await DailyCallStatModel.find({
      date: { $gte: range.from, $lte: range.to },
    }).lean();
    const existingByKey = new Map();
    for (const row of existing) {
      const key = groupKey(row);
      if (existingByKey.has(key)) {
        throw syncError("CALLRAIL_DUPLICATE_TARGET_KEY", "DailyCallStat contained a duplicate date/piece key");
      }
      existingByKey.set(key, row);
    }

    const nowAt = now();
    const presentOperations = [];
    let rowsUnchanged = 0;
    let legacyRowsWouldClaim = 0;
    for (const group of groups.values()) {
      const next = directDocument(group);
      const existingRow = existingByKey.get(groupKey(next)) || null;
      if (existingRow && existingRow.syncSource !== DIRECT_SOURCE) legacyRowsWouldClaim += 1;
      if (existingRow && sameDirectFields(existingRow, next)) {
        rowsUnchanged += 1;
        continue;
      }
      presentOperations.push({
        updateOne: {
          filter: existingRow?._id ? { _id: existingRow._id } : { date: next.date, piece: next.piece },
          update: { $set: { ...next, syncedAt: nowAt } },
          upsert: !existingRow,
        },
      });
    }

    const absentDirectRows = existing.filter((row) => (
      row.syncSource === DIRECT_SOURCE
      && row.active !== false
      && !groups.has(groupKey(row))
    ));

    let writeResult = { modifiedCount: 0, upsertedCount: 0 };
    let retireResult = { modifiedCount: 0 };
    if (!dryRun) {
      if (presentOperations.length > 0) {
        writeResult = await DailyCallStatModel.bulkWrite(presentOperations, { ordered: true });
      }
      if (absentDirectRows.length > 0) {
        retireResult = await DailyCallStatModel.updateMany(
          {
            _id: { $in: absentDirectRows.map((row) => row._id) },
            syncSource: DIRECT_SOURCE,
            active: { $ne: false },
          },
          {
            $set: {
              active: false,
              retiredAt: nowAt,
              retiredReason: RETIRED_REASON,
            },
          },
        );
      }
    }

    return {
      ...range,
      companyKey,
      dryRun: Boolean(dryRun),
      callsSeen: calls.length,
      rowsSeen: groups.size,
      rowsWouldWrite: presentOperations.length,
      rowsUnchanged,
      legacyRowsWouldClaim,
      rowsWouldRetire: absentDirectRows.length,
      rowsWritten: dryRun
        ? 0
        : Number(writeResult.modifiedCount || 0) + Number(writeResult.upsertedCount || 0),
      rowsRetired: dryRun ? 0 : Number(retireResult.modifiedCount || 0),
      responses: [...groups.values()].reduce(
        (sum, group) => sum + group.firstTimeCallers,
        0,
      ),
      // The proven source image, per date and piece, returned rather than only
      // written. A report generated at read time can then use FRESH numbers
      // without persisting anything — which is what keeps `--apply` meaning
      // something while still never printing a stale zero.
      byDatePiece: [...groups.values()].map((g) => ({
        date: g.date,
        piece: g.piece,
        channel: g.channel || null,
        totalCalls: g.totalCalls,
        firstTimeCallers: g.firstTimeCallers,
        uniqueCallers: g.uniqueCallers ?? null,
      })),
    };
  };
}

const syncCallrailDailyStats = createCallrailDailyStatSync();

module.exports = {
  DIRECT_SOURCE,
  RETIRED_REASON,
  assertCompletePayload,
  createCallrailDailyStatSync,
  groupCalls,
  syncCallrailDailyStats,
  validateRange,
};