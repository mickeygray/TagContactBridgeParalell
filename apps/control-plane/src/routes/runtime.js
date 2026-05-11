"use strict";

// Central runtime observability routes. The point: an operator can hit
// ONE endpoint and see whether intake is alive, where the most recent
// failures are, and what the cutover window looks like — without
// having to know which mongo collection to query.
//
// Built specifically for the inbound-cutover canary: during the 24h
// observation period after pointing one CallRail tracking number at
// Parallel, this is the surface that says "lead volume is ramping,
// duplicates aren't happening, STOPs are landing, no webhook is
// silently 500-ing." If any of those go bad, the values surface here
// instead of buried in a workflow-record sub-collection.

const express = require("express");
const mongoose = require("mongoose");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function timeWindow(ms) {
  return new Date(Date.now() - ms);
}

async function buildInboundSnapshot() {
  const db = mongoose.connection.db;
  const oneHourAgo = timeWindow(HOUR_MS);
  const oneDayAgo = timeWindow(DAY_MS);

  // Intake volumes by route in the last hour. `family=inbound` covers
  // every inbound-route workflow stage; we group by subtype so each
  // route shows up as its own line.
  const intakeByRouteLast1h = await db.collection("controlplaneworkflowrecords")
    .aggregate([
      { $match: { family: "inbound", happenedAt: { $gte: oneHourAgo } } },
      { $group: { _id: { subtype: "$subtype", stage: "$stage" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray()
    .catch(() => []);

  // Failed inbound stages last 24h — the "did anything silently
  // 500?" signal Codex called out. Includes the rejected-no-consent
  // gate stage (TrustedForm) so operators can see consent-failures
  // distinct from genuine errors.
  const failedStagesLast24h = await db.collection("controlplaneworkflowrecords")
    .aggregate([
      {
        $match: {
          family: "inbound",
          stage: { $in: ["failed", "rejected"] },
          happenedAt: { $gte: oneDayAgo },
        },
      },
      {
        $group: {
          _id: { subtype: "$subtype", stage: "$stage" },
          count: { $sum: 1 },
          mostRecent: { $max: "$happenedAt" },
        },
      },
      { $sort: { mostRecent: -1 } },
      { $limit: 25 },
    ])
    .toArray()
    .catch(() => []);

  // Channel DNC marks added in last 24h. Read from the LeadCadence
  // collection — `cadenceState.channelDnc.<channel>.at` carries the
  // mark timestamp. Aggregating across all four channels lets us
  // count "things shut off today."
  const channelDncByChannel = {};
  for (const channel of ["sms", "email", "rvm", "cx"]) {
    const count = await db.collection("controlplaneleadcadences")
      .countDocuments({
        [`cadenceState.channelDnc.${channel}.blocked`]: true,
        [`cadenceState.channelDnc.${channel}.at`]: { $gte: oneDayAgo },
      })
      .catch(() => 0);
    channelDncByChannel[channel] = count;
  }

  // Last STOP processed — the inbound STOP webhook logs an
  // `sms.inbound.stop` info entry but we don't have a generic log
  // collection. The closest durable signal is the most recent
  // channelDnc.sms with reason="opted-out-stop-keyword".
  const lastStopMark = await db.collection("controlplaneleadcadences")
    .find({
      "cadenceState.channelDnc.sms.reason": "opted-out-stop-keyword",
    })
    .project({ domain: 1, caseId: 1, "cadenceState.channelDnc.sms": 1 })
    .sort({ "cadenceState.channelDnc.sms.at": -1 })
    .limit(1)
    .toArray()
    .catch(() => []);

  // Most recent hourly job event — proves the retry/reconcile system
  // is alive. If `mostRecentEmittedAt` is more than ~2h old we'd
  // suspect the hourly worker stalled.
  const mostRecentHourlyJob = await db.collection("hourlyjobevents")
    .find({})
    .project({ eventType: 1, status: 1, severity: 1, createdAt: 1, firstError: 1 })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);

  // Unresolved hourly jobs by status. "If unresolved is climbing,
  // something downstream is failing repeatedly."
  const hourlyJobsByStatus = await db.collection("hourlyjobevents")
    .aggregate([
      {
        $match: {
          status: { $in: ["pending", "processing", "failed", "dead-letter"] },
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray()
    .catch(() => []);

  // Lead intake counts in the last hour, by domain + intakeRoute.
  // Shows whether we're seeing balanced traffic across paths.
  const leadIntakeByRouteLast1h = await db.collection("controlplaneleadcadences")
    .aggregate([
      { $match: { createdAt: { $gte: oneHourAgo } } },
      {
        $group: {
          _id: { domain: "$domain", intakeRoute: "$intakeRoute" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray()
    .catch(() => []);

  // Total counts for context (lifetime + today).
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const cadenceTotal = await db.collection("controlplaneleadcadences").estimatedDocumentCount().catch(() => 0);
  const cadenceToday = await db.collection("controlplaneleadcadences").countDocuments({
    createdAt: { $gte: todayStart },
  }).catch(() => 0);

  return {
    generatedAt: new Date().toISOString(),
    windows: {
      oneHourAgo: oneHourAgo.toISOString(),
      oneDayAgo: oneDayAgo.toISOString(),
      todayStart: todayStart.toISOString(),
    },
    intake: {
      cadenceTotal,
      cadenceToday,
      intakeByRouteLast1h,
      leadIntakeByRouteLast1h,
    },
    failures: {
      inboundFailedOrRejectedLast24h: failedStagesLast24h.map((row) => ({
        subtype: row._id.subtype,
        stage: row._id.stage,
        count: row.count,
        mostRecent: row.mostRecent,
      })),
    },
    channelDnc: {
      addedLast24hByChannel: channelDncByChannel,
      lastStopProcessed: lastStopMark[0]
        ? {
            domain: lastStopMark[0].domain,
            caseId: lastStopMark[0].caseId,
            at: lastStopMark[0].cadenceState?.channelDnc?.sms?.at || null,
            reason: lastStopMark[0].cadenceState?.channelDnc?.sms?.reason || null,
          }
        : null,
    },
    hourlyJobs: {
      byStatus: hourlyJobsByStatus.map((row) => ({ status: row._id, count: row.count })),
      mostRecent: mostRecentHourlyJob[0]
        ? {
            eventType: mostRecentHourlyJob[0].eventType,
            status: mostRecentHourlyJob[0].status,
            severity: mostRecentHourlyJob[0].severity,
            createdAt: mostRecentHourlyJob[0].createdAt,
            firstError: mostRecentHourlyJob[0].firstError,
          }
        : null,
    },
  };
}

function createRuntimeRouter(auth) {
  const router = express.Router();

  router.get(
    "/inbound-snapshot",
    auth.requireAuth,
    auth.requireAdmin,
    async (_req, res) => {
      try {
        const snapshot = await buildInboundSnapshot();
        return res.json({ ok: true, snapshot });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createRuntimeRouter,
  buildInboundSnapshot,
};
