"use strict";

const { WorkflowRecord } = require("../../shared-models/src");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function pacificDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

// WorkflowRecord's dedupeKey index is intentionally partial so legacy rows
// without a string key are not forced into the uniqueness constraint. Mongo
// will not use that partial index for an upsert unless the query explicitly
// includes the partial predicate. A plain `{ dedupeKey }` upsert therefore
// scans the entire workflow collection on every receipt update.
function workflowDedupeFilter(value) {
  const dedupeKey = String(value || "").trim();
  if (!dedupeKey) throw new TypeError("dedupeKey is required");
  return {
    $and: [
      { dedupeKey },
      { dedupeKey: { $type: "string" } },
    ],
  };
}

function buildAgedReceiptIncrement(summary = {}) {
  const reasons = summary.dncLookupFailureReasons || {};
  return {
    "result.batches": 1,
    "result.checked": count(summary.checked),
    "result.promoted": count(summary.promoted),
    "result.stayed": count(summary.stayed),
    "result.cleared": count(summary.cleared),
    "result.retired":
      count(summary.evicted)
      + count(summary.droppedAtIntake)
      + count(summary.expiredRetirement?.retired),
    "result.lookupFailures": count(summary.dncLookupFailures),
    "result.lookupFailureReasons.paymentRequired": count(reasons.paymentRequired),
    "result.lookupFailureReasons.rateLimited": count(reasons.rateLimited),
    "result.lookupFailureReasons.authentication": count(reasons.authentication),
    "result.lookupFailureReasons.network": count(reasons.network),
    "result.lookupFailureReasons.other": count(reasons.other),
  };
}

async function recordAgedRefreshBatch(summary = {}, options = {}) {
  if (summary.dryRun) return { recorded: false, reason: "dry-run" };
  const at = new Date(options.at || summary.finishedAt || summary.now || Date.now());
  const dateKey = options.dateKey || pacificDateKey(at);
  const dedupeKey = `nightly-ops:aged-refresh:${dateKey}`;
  await (options.model || WorkflowRecord).updateOne(
    workflowDedupeFilter(dedupeKey),
    {
      $setOnInsert: {
        domain: "SYSTEM",
        family: "aged-refresh",
        subtype: "daily-summary",
        aggregateType: "aged-refresh-day",
        aggregateId: dateKey,
        sourceService: "hourly-sweeper",
        title: "Aged and DNC refresh daily result",
        dedupeKey,
      },
      $set: {
        stage: "completed",
        status: "completed",
        summary: "Count-only aged and DNC refresh result",
        happenedAt: at,
      },
      $inc: buildAgedReceiptIncrement(summary),
    },
    { upsert: true },
  );
  return { recorded: true, dateKey };
}

function summarizeOperationalRecords({ agedRecord = null, bloggerRecord = null } = {}) {
  const agedResult = agedRecord?.result || {};
  const bloggerResult = bloggerRecord?.result || {};
  return {
    aged: agedRecord
      ? {
          status: agedRecord.stage === "failed" ? "failed" : "completed",
          batches: count(agedResult.batches),
          checked: count(agedResult.checked),
          promoted: count(agedResult.promoted),
          stayed: count(agedResult.stayed),
          cleared: count(agedResult.cleared),
          retired: count(agedResult.retired),
          lookupFailures: count(agedResult.lookupFailures),
          lookupFailureReasons: {
            paymentRequired: count(agedResult.lookupFailureReasons?.paymentRequired),
            rateLimited: count(agedResult.lookupFailureReasons?.rateLimited),
            authentication: count(agedResult.lookupFailureReasons?.authentication),
            network: count(agedResult.lookupFailureReasons?.network),
            other: count(agedResult.lookupFailureReasons?.other),
          },
        }
      : { status: "missing" },
    blogger: bloggerRecord
      ? {
          status:
            bloggerRecord.stage === "completed" && bloggerResult.ok !== false
              ? "completed"
              : "failed",
          durationMs: count(bloggerResult.durationMs),
          timedOut: Boolean(bloggerResult.timedOut),
          exitCode: Number.isFinite(Number(bloggerResult.code))
            ? Number(bloggerResult.code)
            : null,
        }
      : { status: "missing" },
  };
}

async function loadNightlyOperationalSummary(dateKey, options = {}) {
  const model = options.model || WorkflowRecord;
  const { start, end } = buildTimezoneDateWindow(dateKey, PACIFIC_TIME_ZONE);
  const [agedRecord, bloggerRecord] = await Promise.all([
    model.findOne(workflowDedupeFilter(`nightly-ops:aged-refresh:${dateKey}`))
      .select("stage status result happenedAt")
      .lean(),
    model.findOne({
      family: "blogger",
      subtype: "blogger-runtime",
      stage: { $in: ["completed", "failed"] },
      happenedAt: { $gte: start, $lte: end },
    })
      .sort({ happenedAt: -1 })
      .select("stage status result.ok result.durationMs result.timedOut result.code happenedAt")
      .lean(),
  ]);
  return summarizeOperationalRecords({ agedRecord, bloggerRecord });
}

module.exports = {
  buildAgedReceiptIncrement,
  loadNightlyOperationalSummary,
  pacificDateKey,
  recordAgedRefreshBatch,
  summarizeOperationalRecords,
  workflowDedupeFilter,
};
