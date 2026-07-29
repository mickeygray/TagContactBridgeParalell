"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TrainingCallReviewAnalysisError,
  createTrainingCallReviewAnalysisService,
} = require("../../packages/shared-services/src/trainingCallReviewAnalysisService");
const {
  TAX_GROUP_SCRIPT,
  TAX_GROUP_SECTIONS,
} = require("../../packages/shared-services/src/taxGroupScript");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

class MemoryTrainingCallReviewRepository {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }

  matchesKey(row, key) {
    return (
      row.learnerKey === key.learnerKey &&
      row.callFingerprint === key.callFingerprint &&
      row.recordingFingerprint === key.recordingFingerprint &&
      row.versions.scriptVersion === key.scriptVersion &&
      row.versions.transcriptVersion === key.transcriptVersion &&
      row.versions.graderVersion === key.graderVersion
    );
  }

  async findOrCreateReview({ key, create }) {
    const existing = this.rows.find((row) => this.matchesKey(row, key));
    if (existing) return clone(existing);
    const row = {
      _id: `review_${this.nextId++}`,
      ...clone(create),
      transcript: { status: "pending" },
      createdAt: new Date("2026-07-28T12:00:00.000Z"),
      updatedAt: new Date("2026-07-28T12:00:00.000Z"),
    };
    this.rows.push(row);
    return clone(row);
  }

  async findReviewById(reviewId) {
    return clone(this.rows.find((row) => row._id === String(reviewId)) || null);
  }

  async claimReview(reviewId, now) {
    const row = this.rows.find((candidate) => candidate._id === String(reviewId));
    if (!row || !["pending", "failed"].includes(row.status)) return null;
    row.status = "processing";
    row.generation += 1;
    row.startedAt = now;
    row.completedAt = null;
    row.failedAt = null;
    row.error = { code: null, at: null };
    return clone(row);
  }

  async findReusableTranscript({
    recordingFingerprint,
    transcriptVersion,
    excludeReviewId,
  }) {
    const row = this.rows.find(
      (candidate) =>
        candidate._id !== String(excludeReviewId) &&
        candidate.recordingFingerprint === recordingFingerprint &&
        candidate.versions.transcriptVersion === transcriptVersion &&
        candidate.transcript?.status === "completed",
    );
    return row
      ? clone({
          _id: row._id,
          transcript: row.transcript,
          versions: row.versions,
        })
      : null;
  }

  async saveTranscript(reviewId, generation, transcript) {
    const row = this.rows.find(
      (candidate) =>
        candidate._id === String(reviewId) &&
        candidate.generation === Number(generation) &&
        candidate.status === "processing",
    );
    if (!row) return null;
    row.transcript = clone(transcript);
    return clone(row);
  }

  async completeReview(reviewId, generation, { analysis, completedAt }) {
    const row = this.rows.find(
      (candidate) =>
        candidate._id === String(reviewId) &&
        candidate.generation === Number(generation) &&
        candidate.status === "processing",
    );
    if (!row) return null;
    row.status = "completed";
    row.analysis = clone(analysis);
    row.completedAt = completedAt;
    row.failedAt = null;
    row.error = { code: null, at: null };
    return clone(row);
  }

  async failReview(reviewId, generation, { code, failedAt }) {
    const row = this.rows.find(
      (candidate) =>
        candidate._id === String(reviewId) &&
        candidate.generation === Number(generation) &&
        candidate.status === "processing",
    );
    if (!row) return null;
    row.status = "failed";
    row.failedAt = failedAt;
    row.error = { code, at: failedAt };
    return clone(row);
  }
}

function fixtureSource(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 12345,
    provider: "phoneburner",
    callFingerprint: "call-sha256:fixture-exact-call",
    recordingFingerprint: "recording-sha256:fixture-stable-audio",
    sourceId: "trsrc_fixtureRecordingSource1234567890",
    startedAt: "2026-07-28T10:00:00.000Z",
    durationSec: 600,
    direction: "outbound",
    agentName: "Fixture Agent",
    outcome: "connected",
    ...overrides,
  };
}

function fixtureTranscript() {
  return {
    provider: "synthetic",
    model: "fixture-transcriber-v1",
    segments: [
      {
        startMs: 0,
        endMs: 1_200,
        text: "To see if representation makes sense, may I ask a few questions?",
        speaker: "agent",
        speakerConfidence: 0.94,
      },
      {
        startMs: 1_300,
        endMs: 2_500,
        text: "Yes, that sounds fair.",
        speaker: "prospect",
        speakerConfidence: 0.91,
      },
    ],
  };
}

function fixtureGrade() {
  return {
    provider: "synthetic",
    model: "fixture-grader-v1",
    scriptFindings: [
      {
        findingId: "script.ask_permission",
        sectionId: "2",
        beatId: "ask_permission",
        status: "observed",
        title: "Asked permission before discovery",
        summary: "The agent opened discovery by asking permission.",
        confidence: 0.93,
        segmentIds: ["seg_000001"],
      },
    ],
    thingsToConsider: [
      {
        findingId: "consider.pacing",
        title: "Leave room for the answer",
        summary: "Consider a slightly longer pause after the permission question.",
        confidence: 0.62,
        segmentIds: ["seg_000001", "seg_000002"],
      },
    ],
  };
}

test("analysis is idempotent, versioned, script-authoritative, and reuses transcripts", async () => {
  const repository = new MemoryTrainingCallReviewRepository();
  const calls = {
    download: 0,
    cleanup: 0,
    transcribe: 0,
    grade: 0,
  };
  let graderAuthority = null;
  const dependencies = {
    repository,
    downloadRecording: async () => {
      calls.download += 1;
      return {
        path: "synthetic://fixture",
        cleanup: async () => {
          calls.cleanup += 1;
        },
      };
    },
    transcribeRecording: async () => {
      calls.transcribe += 1;
      return fixtureTranscript();
    },
    gradeCallReview: async ({ authority }) => {
      calls.grade += 1;
      graderAuthority = authority;
      return fixtureGrade();
    },
    now: () => new Date("2026-07-28T12:00:00.000Z"),
  };
  const service = createTrainingCallReviewAnalysisService(dependencies);

  const first = await service.analyzeCallReview({
    learnerKey: "Learner@Example.com",
    source: fixtureSource(),
    requestId: "request-one",
  });
  const repeated = await service.analyzeCallReview({
    learnerKey: "learner@example.com",
    source: fixtureSource(),
    requestId: "request-two",
  });

  assert.equal(first.reviewId, repeated.reviewId);
  assert.equal(first.status, "completed");
  assert.deepEqual(calls, {
    download: 1,
    cleanup: 1,
    transcribe: 1,
    grade: 1,
  });
  assert.equal(graderAuthority.type, "tax_group_script");
  assert.equal(graderAuthority.script, TAX_GROUP_SCRIPT);
  assert.deepEqual(graderAuthority.sections, TAX_GROUP_SECTIONS);
  assert.equal(
    first.scriptFindings[0].citations[0].quote,
    fixtureTranscript().segments[0].text,
  );
  assert.equal(
    first.thingsToConsider[0].authority,
    "model_generated_advisory",
  );
  assert.equal(Object.hasOwn(first.source, "callFingerprint"), false);
  assert.equal(Object.hasOwn(first, "recordingFingerprint"), false);
  assert.equal(Object.hasOwn(first, "recordingSourceId"), false);
  assert.equal(
    repository.rows.find((row) => row._id === first.reviewId).recordingSourceId,
    fixtureSource().sourceId,
  );

  const changedRecording = await service.analyzeCallReview({
    learnerKey: "learner@example.com",
    source: fixtureSource({
      recordingFingerprint: "recording-sha256:fixture-replaced-audio",
    }),
  });
  assert.notEqual(changedRecording.reviewId, first.reviewId);
  assert.deepEqual(calls, {
    download: 2,
    cleanup: 2,
    transcribe: 2,
    grade: 2,
  });

  const secondLearner = await service.analyzeCallReview({
    learnerKey: "another@example.com",
    source: fixtureSource(),
  });
  assert.notEqual(secondLearner.reviewId, first.reviewId);
  assert.equal(secondLearner.transcript.reused, true);
  assert.deepEqual(calls, {
    download: 2,
    cleanup: 2,
    transcribe: 2,
    grade: 3,
  });

  const revisedGrader = createTrainingCallReviewAnalysisService({
    ...dependencies,
    graderVersion: "training-call-review-grader-v2",
  });
  const revised = await revisedGrader.analyzeCallReview({
    learnerKey: "learner@example.com",
    source: fixtureSource(),
  });
  assert.notEqual(revised.reviewId, first.reviewId);
  assert.equal(revised.transcript.reused, true);
  assert.equal(revised.versions.graderVersion, "training-call-review-grader-v2");
  assert.equal(repository.rows.length, 4);
  assert.deepEqual(calls, {
    download: 2,
    cleanup: 2,
    transcribe: 2,
    grade: 4,
  });
});

test("unknown transcript evidence fails closed and is saved as a failed review", async () => {
  const repository = new MemoryTrainingCallReviewRepository();
  let cleaned = 0;
  const service = createTrainingCallReviewAnalysisService({
    repository,
    downloadRecording: async () => ({
      path: "synthetic://fixture",
      cleanup: async () => {
        cleaned += 1;
      },
    }),
    transcribeRecording: async () => fixtureTranscript(),
    gradeCallReview: async () => {
      const grade = fixtureGrade();
      grade.scriptFindings[0].segmentIds = ["seg_999999"];
      return grade;
    },
    now: () => new Date("2026-07-28T12:00:00.000Z"),
  });

  await assert.rejects(
    service.analyzeCallReview({
      learnerKey: "learner@example.com",
      source: fixtureSource(),
    }),
    (error) =>
      error instanceof TrainingCallReviewAnalysisError &&
      error.code === "TRAINER_CALL_REVIEW_CITATION_INVALID" &&
      error.message === "Call review analysis failed",
  );
  assert.equal(cleaned, 1);
  assert.equal(repository.rows[0].status, "failed");
  assert.equal(
    repository.rows[0].error.code,
    "TRAINER_CALL_REVIEW_CITATION_INVALID",
  );
  assert.equal(repository.rows[0].transcript.status, "completed");
});

test("temporary recording cleanup runs in finally on transcription and grading failures", async (t) => {
  await t.test("transcription failure", async () => {
    const repository = new MemoryTrainingCallReviewRepository();
    let cleaned = 0;
    let graderCalled = false;
    const service = createTrainingCallReviewAnalysisService({
      repository,
      downloadRecording: async () => ({
        path: "synthetic://fixture",
        cleanup: async () => {
          cleaned += 1;
        },
      }),
      transcribeRecording: async () => {
        const error = new Error("synthetic transcription detail");
        error.code = "SYNTHETIC_TRANSCRIBE_FAILURE";
        throw error;
      },
      gradeCallReview: async () => {
        graderCalled = true;
        return fixtureGrade();
      },
    });

    await assert.rejects(
      service.analyzeCallReview({
        learnerKey: "learner@example.com",
        source: fixtureSource(),
      }),
      (error) =>
        error.code === "SYNTHETIC_TRANSCRIBE_FAILURE" &&
        !error.message.includes("synthetic transcription detail"),
    );
    assert.equal(cleaned, 1);
    assert.equal(graderCalled, false);
    assert.equal(repository.rows[0].status, "failed");
  });

  await t.test("grader failure", async () => {
    const repository = new MemoryTrainingCallReviewRepository();
    let cleaned = 0;
    const service = createTrainingCallReviewAnalysisService({
      repository,
      downloadRecording: async () => ({
        path: "synthetic://fixture",
        cleanup: async () => {
          cleaned += 1;
        },
      }),
      transcribeRecording: async () => fixtureTranscript(),
      gradeCallReview: async () => {
        const error = new Error("synthetic grader detail");
        error.code = "SYNTHETIC_GRADER_FAILURE";
        throw error;
      },
    });

    await assert.rejects(
      service.analyzeCallReview({
        learnerKey: "learner@example.com",
        source: fixtureSource(),
      }),
      (error) =>
        error.code === "SYNTHETIC_GRADER_FAILURE" &&
        !error.message.includes("synthetic grader detail"),
    );
    assert.equal(cleaned, 1);
    assert.equal(repository.rows[0].status, "failed");
    assert.equal(repository.rows[0].transcript.status, "completed");
  });
});

test("script findings cannot claim authority outside TAX_GROUP_SECTIONS", async () => {
  const repository = new MemoryTrainingCallReviewRepository();
  const service = createTrainingCallReviewAnalysisService({
    repository,
    downloadRecording: async () => ({
      cleanup: async () => {},
    }),
    transcribeRecording: async () => fixtureTranscript(),
    gradeCallReview: async () => {
      const grade = fixtureGrade();
      grade.scriptFindings[0].beatId = "model_invented_beat";
      return grade;
    },
  });

  await assert.rejects(
    service.analyzeCallReview({
      learnerKey: "learner@example.com",
      source: fixtureSource(),
    }),
    (error) =>
      error.code === "TRAINER_CALL_REVIEW_SCRIPT_CITATION_INVALID",
  );
});
