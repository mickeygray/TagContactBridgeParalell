"use strict";

const { TrainingCallReview } = require("../../shared-models/src");

const DEFAULT_PROCESSING_LEASE_MS = 30 * 60 * 1000;

function normalizeLearnerKey(value) {
  return String(value || "").trim().toLowerCase();
}

function buildReviewKey(input = {}) {
  return {
    learnerKey: normalizeLearnerKey(input.learnerKey),
    callFingerprint: String(input.callFingerprint || "").trim(),
    recordingFingerprint: String(input.recordingFingerprint || "").trim(),
    "versions.scriptVersion": String(input.scriptVersion || "").trim(),
    "versions.transcriptVersion": String(input.transcriptVersion || "").trim(),
    "versions.graderVersion": String(input.graderVersion || "").trim(),
  };
}

async function findOrCreateReview({ key, create }) {
  const query = buildReviewKey(key);
  try {
    return await TrainingCallReview.findOneAndUpdate(
      query,
      { $setOnInsert: create },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return TrainingCallReview.findOne(query).lean();
  }
}

async function findReviewById(reviewId) {
  return TrainingCallReview.findById(reviewId).lean();
}

async function claimReview(
  reviewId,
  now = new Date(),
  { processingLeaseMs = DEFAULT_PROCESSING_LEASE_MS } = {},
) {
  const effectiveNow = new Date(now);
  const leaseMs = Math.max(
    1_000,
    Math.min(
      Number(processingLeaseMs) || DEFAULT_PROCESSING_LEASE_MS,
      24 * 60 * 60 * 1000,
    ),
  );
  const staleBefore = new Date(effectiveNow.getTime() - leaseMs);
  return TrainingCallReview.findOneAndUpdate(
    {
      _id: reviewId,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "processing", startedAt: { $lte: staleBefore } },
        { status: "processing", startedAt: null },
      ],
    },
    {
      $set: {
        status: "processing",
        error: { code: null, at: null },
        startedAt: effectiveNow,
        completedAt: null,
        failedAt: null,
      },
      $inc: { generation: 1 },
    },
    { new: true },
  ).lean();
}

async function findReusableTranscript({
  recordingFingerprint,
  transcriptVersion,
  excludeReviewId = null,
}) {
  const query = {
    recordingFingerprint: String(recordingFingerprint || "").trim(),
    "versions.transcriptVersion": String(transcriptVersion || "").trim(),
    "transcript.status": "completed",
  };
  if (excludeReviewId) query._id = { $ne: excludeReviewId };
  return TrainingCallReview.findOne(query)
    .sort({ "transcript.completedAt": -1, updatedAt: -1 })
    .select({ transcript: 1, versions: 1 })
    .lean();
}

async function saveTranscript(reviewId, generation, transcript) {
  return TrainingCallReview.findOneAndUpdate(
    {
      _id: reviewId,
      generation: Number(generation),
      status: "processing",
    },
    { $set: { transcript } },
    { new: true },
  ).lean();
}

async function completeReview(
  reviewId,
  generation,
  { analysis, completedAt = new Date() },
) {
  return TrainingCallReview.findOneAndUpdate(
    {
      _id: reviewId,
      generation: Number(generation),
      status: "processing",
    },
    {
      $set: {
        status: "completed",
        analysis,
        completedAt,
        failedAt: null,
        error: { code: null, at: null },
      },
    },
    { new: true },
  ).lean();
}

async function failReview(
  reviewId,
  generation,
  { code, failedAt = new Date() },
) {
  return TrainingCallReview.findOneAndUpdate(
    {
      _id: reviewId,
      generation: Number(generation),
      status: "processing",
    },
    {
      $set: {
        status: "failed",
        failedAt,
        error: {
          code: String(code || "TRAINER_CALL_REVIEW_ANALYSIS_FAILED"),
          at: failedAt,
        },
      },
    },
    { new: true },
  ).lean();
}

module.exports = {
  DEFAULT_PROCESSING_LEASE_MS,
  buildReviewKey,
  claimReview,
  completeReview,
  failReview,
  findOrCreateReview,
  findReusableTranscript,
  findReviewById,
  normalizeLearnerKey,
  saveTranscript,
};
