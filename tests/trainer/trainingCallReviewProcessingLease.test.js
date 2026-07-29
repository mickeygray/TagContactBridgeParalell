"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_PROCESSING_LEASE_MS,
  createTrainingCallReviewAnalysisService,
} = require("../../packages/shared-services/src/trainingCallReviewAnalysisService");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

class LeaseMemoryRepository {
  constructor() {
    this.row = {
      _id: "review_processing_lease",
      learnerKey: "learner@example.com",
      callFingerprint: "call:lease-fixture",
      recordingFingerprint: "recording:lease-fixture",
      domain: "TAG",
      caseId: 12345,
      source: {
        provider: "ex",
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        durationSec: 600,
        direction: "outbound",
        agentName: "Fixture Agent",
        outcome: "connected",
      },
      versions: {
        scriptVersion: "script:v1",
        transcriptVersion: "transcript:v1",
        graderVersion: "grader:v1",
      },
      status: "processing",
      generation: 1,
      transcript: { status: "pending" },
      startedAt: new Date("2026-07-28T09:45:00.000Z"),
      createdAt: new Date("2026-07-28T09:00:00.000Z"),
    };
    this.claimCalls = 0;
    this.lastLeaseMs = null;
  }

  async findOrCreateReview() {
    return clone(this.row);
  }

  async claimReview(reviewId, now, { processingLeaseMs }) {
    this.claimCalls += 1;
    this.lastLeaseMs = processingLeaseMs;
    if (this.row._id !== String(reviewId)) return null;
    const startedAt = new Date(this.row.startedAt).getTime();
    const stale =
      !Number.isFinite(startedAt) ||
      new Date(now).getTime() - startedAt >= processingLeaseMs;
    if (this.row.status === "processing" && !stale) return null;
    if (
      this.row.status !== "processing" &&
      !["pending", "failed"].includes(this.row.status)
    ) {
      return null;
    }
    this.row.status = "processing";
    this.row.generation += 1;
    this.row.startedAt = new Date(now);
    this.row.completedAt = null;
    this.row.failedAt = null;
    this.row.error = null;
    return clone(this.row);
  }

  async findReviewById() {
    return clone(this.row);
  }

  async findReusableTranscript() {
    return null;
  }

  async saveTranscript(reviewId, generation, transcript) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.status !== "processing" ||
      this.row.generation !== generation
    ) {
      return null;
    }
    this.row.transcript = clone(transcript);
    return clone(this.row);
  }

  async completeReview(reviewId, generation, { analysis, completedAt }) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.status !== "processing" ||
      this.row.generation !== generation
    ) {
      return null;
    }
    this.row.status = "completed";
    this.row.analysis = clone(analysis);
    this.row.completedAt = new Date(completedAt);
    return clone(this.row);
  }

  async failReview(reviewId, generation, { code, failedAt }) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.status !== "processing" ||
      this.row.generation !== generation
    ) {
      return null;
    }
    this.row.status = "failed";
    this.row.error = { code, at: new Date(failedAt) };
    return clone(this.row);
  }
}

function sourceFixture() {
  return {
    domain: "TAG",
    caseId: 12345,
    provider: "ex",
    callFingerprint: "call:lease-fixture",
    recordingFingerprint: "recording:lease-fixture",
    sourceId: "trsrc_processingLeaseFixture123456",
    startedAt: "2026-07-28T09:00:00.000Z",
    durationSec: 600,
    direction: "outbound",
    agentName: "Fixture Agent",
    outcome: "connected",
  };
}

test("fresh processing stays idempotent while stale processing is reclaimed with generation fencing", async () => {
  const repository = new LeaseMemoryRepository();
  let downloads = 0;
  let cleanups = 0;
  let transcriptions = 0;
  let grades = 0;
  const service = createTrainingCallReviewAnalysisService({
    repository,
    downloadRecording: async () => {
      downloads += 1;
      return {
        cleanup: async () => {
          cleanups += 1;
        },
      };
    },
    transcribeRecording: async () => {
      transcriptions += 1;
      return {
        segments: [
          {
            startMs: 0,
            endMs: 1_000,
            text: "May I ask a few questions?",
            speaker: "agent",
            speakerConfidence: 0.9,
          },
        ],
      };
    },
    gradeCallReview: async () => {
      grades += 1;
      return {
        scriptFindings: [
          {
            findingId: "script.ask_permission",
            sectionId: "2",
            beatId: "ask_permission",
            status: "observed",
            title: "Asked permission",
            summary: "The agent asked permission before discovery.",
            confidence: 0.9,
            segmentIds: ["seg_000001"],
          },
        ],
        thingsToConsider: [],
      };
    },
    now: () => new Date("2026-07-28T10:00:00.000Z"),
  });

  const fresh = await service.analyzeCallReview({
    learnerKey: "learner@example.com",
    source: sourceFixture(),
  });
  assert.equal(fresh.status, "processing");
  assert.equal(fresh.generation, 1);
  assert.equal(repository.lastLeaseMs, DEFAULT_PROCESSING_LEASE_MS);
  assert.deepEqual(
    { downloads, cleanups, transcriptions, grades },
    { downloads: 0, cleanups: 0, transcriptions: 0, grades: 0 },
  );

  repository.row.startedAt = new Date("2026-07-28T09:00:00.000Z");
  const reclaimed = await service.analyzeCallReview({
    learnerKey: "learner@example.com",
    source: sourceFixture(),
  });
  assert.equal(reclaimed.status, "completed");
  assert.equal(reclaimed.generation, 2);
  assert.deepEqual(
    { downloads, cleanups, transcriptions, grades },
    { downloads: 1, cleanups: 1, transcriptions: 1, grades: 1 },
  );

  const staleWorkerWrite = await repository.completeReview(
    repository.row._id,
    1,
    {
      analysis: { scriptFindings: [], thingsToConsider: [] },
      completedAt: new Date("2026-07-28T10:01:00.000Z"),
    },
  );
  assert.equal(staleWorkerWrite, null);
  assert.equal(repository.row.generation, 2);
  assert.equal(repository.row.status, "completed");
});
