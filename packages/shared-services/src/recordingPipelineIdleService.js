"use strict";

const mongoose = require("mongoose");
const { CallLog, HourlyJobEvent } = require("../../shared-models/src");

const ACTIVE_RECORDING_JOB_HANDLERS = Object.freeze([
  "retryCallRecordingPipeline",
  "retryCallRecordingArchive",
]);

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

async function ensureMongoConnected(mongoUri = process.env.MONGO_URI) {
  if (mongoose.connection.readyState === 1) return false;
  if (mongoose.connection.readyState === 2) {
    if (typeof mongoose.connection.asPromise === "function") {
      await mongoose.connection.asPromise();
    }
    return false;
  }
  if (!mongoUri) {
    throw new Error("MONGO_URI is required to check recording pipeline idle state");
  }
  await mongoose.connect(mongoUri);
  return true;
}

async function getRecordingPipelineActivity(options = {}) {
  const sampleLimit = Math.max(numberOrDefault(options.sampleLimit, 5), 0);
  if (options.connect !== false) {
    await ensureMongoConnected(options.mongoUri);
  }

  const activeCallQuery = {
    $or: [
      { "transcription.status": "processing" },
      { "recordingArchive.status": "processing" },
    ],
  };
  const activeJobQuery = {
    handlerKey: { $in: ACTIVE_RECORDING_JOB_HANDLERS },
    status: "processing",
  };

  const [transcriptionProcessing, archiveProcessing, jobProcessing, callSamples, jobSamples] =
    await Promise.all([
      CallLog.countDocuments({ "transcription.status": "processing" }),
      CallLog.countDocuments({ "recordingArchive.status": "processing" }),
      HourlyJobEvent.countDocuments(activeJobQuery),
      sampleLimit > 0
        ? CallLog.find(
            activeCallQuery,
            {
              domain: 1,
              telephonySessionId: 1,
              "transcription.status": 1,
              "recordingArchive.status": 1,
              updatedAt: 1,
            },
          )
            .sort({ updatedAt: -1 })
            .limit(sampleLimit)
            .lean()
        : Promise.resolve([]),
      sampleLimit > 0
        ? HourlyJobEvent.find(
            activeJobQuery,
            {
              lane: 1,
              domain: 1,
              handlerKey: 1,
              aggregateId: 1,
              claimedAt: 1,
              updatedAt: 1,
            },
          )
            .sort({ updatedAt: -1 })
            .limit(sampleLimit)
            .lean()
        : Promise.resolve([]),
    ]);

  const counts = {
    transcriptionProcessing,
    archiveProcessing,
    jobProcessing,
  };

  return {
    idle:
      transcriptionProcessing === 0 &&
      archiveProcessing === 0 &&
      jobProcessing === 0,
    counts,
    samples: {
      callLogs: callSamples,
      hourlyJobs: jobSamples,
    },
  };
}

async function waitForRecordingPipelineIdle(options = {}) {
  const label = String(options.label || "recording-pipeline").trim();
  const logger = options.logger || null;
  const pollMs = Math.max(numberOrDefault(options.pollMs, 60000), 1000);
  const maxWaitMs = Math.max(numberOrDefault(options.maxWaitMs, 12 * 60 * 60 * 1000), 0);
  const startedAt = Date.now();

  for (;;) {
    const activity = await getRecordingPipelineActivity(options);
    const waitedMs = Date.now() - startedAt;
    if (activity.idle) {
      logger?.info?.("recording-pipeline.idle", {
        label,
        waitedMs,
        counts: activity.counts,
      });
      return {
        ok: true,
        waitedMs,
        activity,
      };
    }

    logger?.info?.("recording-pipeline.waiting", {
      label,
      waitedMs,
      pollMs,
      maxWaitMs,
      counts: activity.counts,
      samples: activity.samples,
    });

    if (maxWaitMs > 0 && waitedMs >= maxWaitMs) {
      const error = new Error(`Timed out waiting for recording pipeline idle state (${label})`);
      error.activity = activity;
      error.waitedMs = waitedMs;
      throw error;
    }

    await sleep(pollMs);
  }
}

module.exports = {
  ACTIVE_RECORDING_JOB_HANDLERS,
  ensureMongoConnected,
  getRecordingPipelineActivity,
  waitForRecordingPipelineIdle,
};
