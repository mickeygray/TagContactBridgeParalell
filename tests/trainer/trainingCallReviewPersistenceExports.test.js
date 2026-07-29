"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TrainingCallReview,
  MODEL_REGISTRY,
} = require("../../packages/shared-models/src");
const {
  trainingCallReviewRepository,
} = require("../../packages/shared-repositories/src");

test("TrainingCallReview model and repository are exported with the natural-key index", () => {
  assert.equal(
    TrainingCallReview.modelName,
    "ControlPlaneTrainingCallReview",
  );
  assert.equal(MODEL_REGISTRY.TrainingCallReview, TrainingCallReview);
  assert.equal(
    typeof trainingCallReviewRepository.findOrCreateReview,
    "function",
  );

  const naturalKeyIndex = TrainingCallReview.schema
    .indexes()
    .find(([, options]) =>
      options.name === "learner_call_recording_analysis_version");
  assert.ok(naturalKeyIndex);
  assert.equal(naturalKeyIndex[1].unique, true);
  assert.deepEqual(naturalKeyIndex[0], {
    learnerKey: 1,
    callFingerprint: 1,
    recordingFingerprint: 1,
    "versions.scriptVersion": 1,
    "versions.transcriptVersion": 1,
    "versions.graderVersion": 1,
  });
});

test("repository natural keys normalize learner identity but retain exact versions", () => {
  assert.deepEqual(
    trainingCallReviewRepository.buildReviewKey({
      learnerKey: " Learner@Example.com ",
      callFingerprint: " call:exact ",
      recordingFingerprint: " recording:exact ",
      scriptVersion: " script:v1 ",
      transcriptVersion: " transcript:v1 ",
      graderVersion: " grader:v1 ",
    }),
    {
      learnerKey: "learner@example.com",
      callFingerprint: "call:exact",
      recordingFingerprint: "recording:exact",
      "versions.scriptVersion": "script:v1",
      "versions.transcriptVersion": "transcript:v1",
      "versions.graderVersion": "grader:v1",
    },
  );
});
