"use strict";

/**
 * agentCallStatsService
 *
 * Per-agent call rollups (today / week / month / lifetime) split by
 * direction (inbound/outbound) and platform (ex/cx).
 *
 * Lazy-computed: the GET /api/admin/accounts/:id/call-stats route
 * calls `getOrComputeAgentCallStats` which:
 *   - Returns the cached `AgentState.callStatsSnapshot` when fresh
 *     (younger than DEFAULT_TTL_MS)
 *   - Otherwise aggregates from CallLog by extensionId (plus any
 *     additionalExtensionIds stored on the UserAccount metadata so
 *     wynn/amity tenant seats roll up onto the agent's TAG UA)
 *   - Stamps the result onto AgentState.callStatsSnapshot for the
 *     next reader and returns it
 *
 * No touch to the existing call-end / presence increment paths —
 * this service reads CallLog and writes only to AgentState's
 * snapshot field.
 *
 * CX/EX split caveat: `CallLog.platform` is a forward-looking stamp.
 * Rows written before that stamp landed have platform=null and won't
 * count toward either cxCalls or exCalls (they still count toward
 * total/in/out). This is intentional — the user accepted the
 * "forward looking" model rather than backfilling history.
 */

const { CallLog, AgentState } = require("../../shared-models/src");

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5-min snapshot staleness window
const DEFAULT_TIMEZONE = "America/Los_Angeles";

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function startOfDayInZone(date, timezone) {
  // Resolve the date's local-zone Y-M-D, then build a UTC instant at
  // 00:00:00 in that zone. Done via Intl.DateTimeFormat which handles
  // DST + zone offsets correctly without a moment-tz dependency.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // ISO "YYYY-MM-DDT00:00:00" — interpret as wall-clock in the zone.
  // To get the UTC instant that corresponds to local-midnight, we ask
  // Intl what the zone offset is at that wall-clock moment. Easiest
  // shortcut: build a Date in zone using a known trick.
  const isoLocal = `${lookup.year}-${lookup.month}-${lookup.day}T00:00:00`;
  // Use the Date constructor with the zoned wall-clock as if it were
  // local, then correct by the difference between that local time
  // and the zone-equivalent. This works for any single-DST-transition
  // boundary because Intl handles the offset.
  const utcGuess = new Date(`${isoLocal}Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const zonedParts = Object.fromEntries(
    fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]),
  );
  const zonedAsUtc = Date.UTC(
    Number(zonedParts.year),
    Number(zonedParts.month) - 1,
    Number(zonedParts.day),
    Number(zonedParts.hour),
    Number(zonedParts.minute),
    Number(zonedParts.second),
  );
  const offsetMs = zonedAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

function buildWindowCutoffs(now, timezone) {
  const todayStart = startOfDayInZone(now, timezone);

  // Week start = Monday in the agent's timezone. Compute Monday by
  // walking back the day-of-week (1..7 ISO with Monday=1).
  // Need day-of-week in the zone, not the host system.
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  const isoWeekIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[dayName] || 1;
  const weekStart = new Date(todayStart.getTime() - (isoWeekIndex - 1) * 24 * 60 * 60 * 1000);

  // Month start = first day of the current month in the agent's tz.
  const monthParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const monthLookup = Object.fromEntries(monthParts.map((p) => [p.type, p.value]));
  const monthStart = startOfDayInZone(
    new Date(`${monthLookup.year}-${monthLookup.month}-01T12:00:00Z`),
    timezone,
  );

  return { todayStart, weekStart, monthStart };
}

/**
 * Run the aggregation against CallLog for a set of extension IDs and a
 * time-window cutoff. Returns the bucketed counts.
 */
async function aggregateBucket(extensionIds, since) {
  if (!extensionIds.length) return emptyBucket();
  const match = {
    extensionId: { $in: extensionIds },
  };
  if (since) match.callStartTime = { $gte: since };

  const [row] = await CallLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        outboundCalls: {
          $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
        },
        inboundCalls: {
          $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
        },
        cxCalls: {
          $sum: { $cond: [{ $eq: ["$platform", "cx"] }, 1, 0] },
        },
        exCalls: {
          $sum: { $cond: [{ $eq: ["$platform", "ex"] }, 1, 0] },
        },
        longestCallSec: { $max: "$durationSec" },
        lastCallAt: { $max: "$callStartTime" },
      },
    },
    {
      $project: {
        _id: 0,
        totalCalls: 1,
        outboundCalls: 1,
        inboundCalls: 1,
        cxCalls: 1,
        exCalls: 1,
        longestCallSec: { $ifNull: ["$longestCallSec", 0] },
        lastCallAt: 1,
      },
    },
  ]);
  return row || emptyBucket();
}

function emptyBucket() {
  return {
    totalCalls: 0,
    outboundCalls: 0,
    inboundCalls: 0,
    cxCalls: 0,
    exCalls: 0,
    longestCallSec: 0,
    lastCallAt: null,
  };
}

/**
 * Build the four-bucket snapshot for an agent. The caller passes in
 * the primary extensionId plus any additionalExtensionIds (e.g. from
 * UserAccount.metadata.additionalExtensionIds on cross-tenant agents).
 */
async function buildAgentCallStats({
  extensionId,
  additionalExtensionIds = [],
  timezone = DEFAULT_TIMEZONE,
  now = new Date(),
} = {}) {
  const ids = [extensionId, ...additionalExtensionIds]
    .map((id) => (id != null ? String(id) : null))
    .filter(Boolean);

  if (ids.length === 0) {
    return {
      today: emptyBucket(),
      week: emptyBucket(),
      month: emptyBucket(),
      lifetime: emptyBucket(),
      computedAt: now,
    };
  }

  const { todayStart, weekStart, monthStart } = buildWindowCutoffs(now, timezone);

  const [today, week, month, lifetime] = await Promise.all([
    aggregateBucket(ids, todayStart),
    aggregateBucket(ids, weekStart),
    aggregateBucket(ids, monthStart),
    aggregateBucket(ids, null),
  ]);

  return { today, week, month, lifetime, computedAt: now };
}

function snapshotIsFresh(snapshot, ttlMs) {
  if (!snapshot?.computedAt) return false;
  const computed = new Date(snapshot.computedAt).getTime();
  if (!Number.isFinite(computed)) return false;
  return Date.now() - computed < ttlMs;
}

/**
 * Returns the snapshot for an agent, computing + caching on AgentState
 * if stale or absent. `force: true` skips the cache check.
 */
async function getOrComputeAgentCallStats({
  account,
  agentState,
  force = false,
  ttlMs = DEFAULT_TTL_MS,
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  if (!account) {
    throw new Error("getOrComputeAgentCallStats requires an account");
  }
  const extensionId = account.extensionId || agentState?.extensionId || null;
  const additionalExtensionIds = Array.isArray(
    account.metadata?.additionalExtensionIds,
  )
    ? account.metadata.additionalExtensionIds
    : [];

  if (!extensionId && additionalExtensionIds.length === 0) {
    // Unpaired account — nothing to aggregate.
    return {
      snapshot: {
        today: emptyBucket(),
        week: emptyBucket(),
        month: emptyBucket(),
        lifetime: emptyBucket(),
        computedAt: new Date(),
      },
      cached: false,
      reason: "no-extension",
    };
  }

  // Cache check
  if (!force && agentState?.callStatsSnapshot) {
    const cached = agentState.callStatsSnapshot;
    if (snapshotIsFresh(cached, ttlMs)) {
      return { snapshot: cached, cached: true };
    }
  }

  const snapshot = await buildAgentCallStats({
    extensionId,
    additionalExtensionIds,
    timezone,
    now: new Date(),
  });

  // Persist on AgentState — single $set so a concurrent presence write
  // doesn't lose-update us.
  if (extensionId) {
    await AgentState.updateOne(
      { extensionId: String(extensionId) },
      { $set: { callStatsSnapshot: snapshot } },
    ).catch(() => null);
  }

  return { snapshot, cached: false };
}

/**
 * Mark an agent's call-stats snapshot stale without deleting it. Used
 * by the call-placement path so the next admin board read recomputes
 * fresh stats instead of serving the 5-min-old cached snapshot.
 *
 * Non-destructive on purpose: we only backdate `computedAt` to epoch 0
 * so `snapshotIsFresh()` returns false. The cached numbers remain on
 * AgentState as a fallback if the recompute fails for any reason.
 *
 * Safe to call with a missing/empty extensionId — it just no-ops.
 * Errors are swallowed so this never blocks the call-placement flow.
 */
async function invalidateAgentCallStatsSnapshot(extensionId) {
  const id = String(extensionId || "").trim();
  if (!id) return { ok: true, skipped: "no-extension" };
  try {
    await AgentState.updateOne(
      { extensionId: id },
      { $set: { "callStatsSnapshot.computedAt": new Date(0) } },
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_TIMEZONE,
  buildAgentCallStats,
  buildWindowCutoffs,
  emptyBucket,
  getOrComputeAgentCallStats,
  invalidateAgentCallStatsSnapshot,
};
