"use strict";

const { MetricsSnapshot } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function buildTodayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

async function incrementMetricSnapshot({
  domain,
  bucketType,
  bucketKey,
  bucketDate = null,
  metricName,
  sourceKey = null,
  amount = 1,
  eventSummary = null,
}) {
  const update = {
    $inc: {
      [`counters.${metricName}`]: Number(amount || 1),
    },
    $setOnInsert: {
      domain: normalizeDomain(domain),
      bucketType,
      bucketKey,
      bucketDate,
    },
  };

  if (sourceKey) {
    update.$inc[`sourceCounters.${sourceKey}`] = Number(amount || 1);
  }

  if (eventSummary) {
    update.$push = {
      recentEvents: {
        $each: [eventSummary],
        $slice: -25,
      },
    };
  }

  return MetricsSnapshot.findOneAndUpdate(
    {
      domain: normalizeDomain(domain),
      bucketType,
      bucketKey,
    },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function recordMetricEvent(domain, {
  metricName,
  sourceKey = null,
  amount = 1,
  caseId = null,
  title = null,
  eventType = null,
  happenedAt = new Date(),
}) {
  const normalizedDomain = normalizeDomain(domain);
  const now = new Date(happenedAt || new Date());
  const dailyKey = buildTodayKey(now);
  const summary = {
    eventType,
    metricName,
    sourceKey,
    caseId: caseId != null ? Number(caseId) : null,
    title,
    happenedAt: now,
  };

  const [daily, lifetime] = await Promise.all([
    incrementMetricSnapshot({
      domain: normalizedDomain,
      bucketType: "daily",
      bucketKey: dailyKey,
      bucketDate: new Date(`${dailyKey}T00:00:00.000Z`),
      metricName,
      sourceKey,
      amount,
      eventSummary: summary,
    }),
    incrementMetricSnapshot({
      domain: normalizedDomain,
      bucketType: "lifetime",
      bucketKey: "all-time",
      bucketDate: null,
      metricName,
      sourceKey,
      amount,
      eventSummary: summary,
    }),
  ]);

  return { daily, lifetime };
}

async function findMetricsSnapshot(domain, bucketType, bucketKey) {
  return MetricsSnapshot.findOne({
    domain: normalizeDomain(domain),
    bucketType,
    bucketKey,
  }).lean();
}

async function getLatestDailyMetrics(domain) {
  return MetricsSnapshot.findOne({
    domain: normalizeDomain(domain),
    bucketType: "daily",
  })
    .sort({ bucketKey: -1, updatedAt: -1 })
    .lean();
}

module.exports = {
  findMetricsSnapshot,
  getLatestDailyMetrics,
  incrementMetricSnapshot,
  recordMetricEvent,
};
