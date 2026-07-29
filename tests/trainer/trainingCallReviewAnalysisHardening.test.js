"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { TrainingCallReview } = require("../../packages/shared-models/src");
const {
  TrainingCallReviewAnalysisError,
  createTrainingCallReviewAnalysisService,
  normalizeAnalysisOutput,
  toPublicReview,
} = require("../../packages/shared-services/src/trainingCallReviewAnalysisService");
const {
  buildGradingTool,
} = require("../../packages/shared-services/src/trainingCallReviewModelService");
const {
  normalizeTimestampedTranscript,
} = require("../../packages/shared-services/src/trainingCallReviewTranscriptContract");

function gradeFixture(status = "observed") {
  return {
    provider: "synthetic",
    model: "fixture-grader",
    scriptFindings: [
      {
        findingId: "script.ask_permission",
        sectionId: "2",
        beatId: "ask_permission",
        status,
        title: "Asked permission",
        summary: "The evidence is evaluated against the approved beat.",
        confidence: 0.9,
        segmentIds: ["seg_000001"],
      },
    ],
    thingsToConsider: [],
  };
}

function transcriptWithSpeaker(speaker, speakerConfidence) {
  return normalizeTimestampedTranscript({
    segments: [
      {
        startMs: 0,
        endMs: 1_000,
        text: "May I ask a few questions?",
        speaker,
        speakerConfidence,
      },
    ],
  });
}

test("script conclusions become uncertain without cited >=0.8 agent evidence", () => {
  for (const transcript of [
    transcriptWithSpeaker("unknown", null),
    transcriptWithSpeaker("agent", 0.79),
    transcriptWithSpeaker("prospect", 0.99),
  ]) {
    const normalized = normalizeAnalysisOutput(gradeFixture(), transcript);
    assert.equal(normalized.scriptFindings[0].status, "uncertain");
  }

  const threshold = normalizeAnalysisOutput(
    gradeFixture(),
    transcriptWithSpeaker("agent", 0.8),
  );
  assert.equal(threshold.scriptFindings[0].status, "observed");

  const explicitUncertain = normalizeAnalysisOutput(
    gradeFixture("uncertain"),
    transcriptWithSpeaker("agent", 0.99),
  );
  assert.equal(explicitUncertain.scriptFindings[0].status, "uncertain");
});

test("uncertain is accepted by the model tool, persisted schema, and public projection", () => {
  const toolStatuses =
    buildGradingTool()
      .input_schema
      .properties
      .scriptFindings
      .items
      .properties
      .status
      .enum;
  assert.ok(toolStatuses.includes("uncertain"));

  const persistedStatuses =
    TrainingCallReview.schema
      .path("analysis.scriptFindings")
      .schema
      .path("status")
      .enumValues;
  assert.ok(persistedStatuses.includes("uncertain"));

  const normalized = normalizeAnalysisOutput(
    gradeFixture(),
    transcriptWithSpeaker("unknown", null),
  );
  const projected = toPublicReview({
    _id: "review_uncertain",
    status: "completed",
    generation: 1,
    versions: {},
    source: {},
    transcript: { status: "pending" },
    recordingSourceId: "trsrc_privateMustNotProject123456",
    analysis: normalized,
  });
  assert.equal(projected.scriptFindings[0].status, "uncertain");
  assert.equal(Object.hasOwn(projected, "recordingSourceId"), false);
});

class RetryMemoryRepository {
  constructor() {
    this.row = null;
    this.cacheLookups = 0;
  }

  async findOrCreateReview({ create }) {
    if (!this.row) {
      this.row = {
        _id: "review_retry",
        ...structuredClone(create),
        transcript: { status: "pending" },
        createdAt: new Date("2026-07-28T12:00:00.000Z"),
      };
    }
    return structuredClone(this.row);
  }

  async claimReview(reviewId, now) {
    if (
      this.row._id !== String(reviewId) ||
      !["pending", "failed"].includes(this.row.status)
    ) {
      return null;
    }
    this.row.status = "processing";
    this.row.generation += 1;
    this.row.startedAt = now;
    this.row.error = null;
    return structuredClone(this.row);
  }

  async findReusableTranscript() {
    this.cacheLookups += 1;
    return null;
  }

  async saveTranscript(reviewId, generation, transcript) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.generation !== generation ||
      this.row.status !== "processing"
    ) {
      return null;
    }
    this.row.transcript = structuredClone(transcript);
    return structuredClone(this.row);
  }

  async completeReview(reviewId, generation, { analysis, completedAt }) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.generation !== generation ||
      this.row.status !== "processing"
    ) {
      return null;
    }
    this.row.status = "completed";
    this.row.analysis = structuredClone(analysis);
    this.row.completedAt = completedAt;
    return structuredClone(this.row);
  }

  async failReview(reviewId, generation, { code, failedAt }) {
    if (
      this.row._id !== String(reviewId) ||
      this.row.generation !== generation ||
      this.row.status !== "processing"
    ) {
      return null;
    }
    this.row.status = "failed";
    this.row.failedAt = failedAt;
    this.row.error = { code, at: failedAt };
    return structuredClone(this.row);
  }

  async findReviewById() {
    return structuredClone(this.row);
  }
}

test("retrying the same failed review reuses its saved transcript before cross-review lookup", async () => {
  const repository = new RetryMemoryRepository();
  let downloads = 0;
  let transcriptions = 0;
  let cleanups = 0;
  let grades = 0;
  let failGrader = true;
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
        provider: "synthetic",
        model: "fixture-transcriber",
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
      if (failGrader) {
        const error = new Error("synthetic private detail");
        error.code = "SYNTHETIC_GRADER_FAILURE";
        throw error;
      }
      return gradeFixture();
    },
    now: () => new Date("2026-07-28T12:00:00.000Z"),
  });
  const input = {
    learnerKey: "learner@example.com",
    source: {
      domain: "TAG",
      caseId: 12345,
      provider: "ex",
      callFingerprint: "call:exact-retry",
      recordingFingerprint: "recording:exact-retry",
      startedAt: "2026-07-28T10:00:00.000Z",
      durationSec: 600,
      direction: "outbound",
      agentName: "Fixture Agent",
      outcome: "connected",
    },
  };

  await assert.rejects(
    service.analyzeCallReview(input),
    (error) =>
      error instanceof TrainingCallReviewAnalysisError &&
      error.code === "SYNTHETIC_GRADER_FAILURE",
  );
  assert.equal(repository.row.status, "failed");
  assert.equal(repository.row.transcript.status, "completed");
  assert.deepEqual(
    { downloads, transcriptions, cleanups, grades, cacheLookups: repository.cacheLookups },
    { downloads: 1, transcriptions: 1, cleanups: 1, grades: 1, cacheLookups: 1 },
  );

  failGrader = false;
  const completed = await service.analyzeCallReview(input);
  assert.equal(completed.status, "completed");
  assert.equal(completed.generation, 2);
  assert.equal(completed.transcript.reused, true);
  assert.equal(completed.scriptFindings[0].status, "observed");
  assert.deepEqual(
    { downloads, transcriptions, cleanups, grades, cacheLookups: repository.cacheLookups },
    { downloads: 1, transcriptions: 1, cleanups: 1, grades: 2, cacheLookups: 1 },
  );
});
