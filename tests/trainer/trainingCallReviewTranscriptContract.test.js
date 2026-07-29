"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertEvidenceCitations,
  normalizeTimestampedTranscript,
} = require("../../packages/shared-services/src/trainingCallReviewTranscriptContract");

test("verbose transcript segments retain timestamped, citable evidence", () => {
  const transcript = normalizeTimestampedTranscript({
    text: "legacy flattened text is not authoritative",
    segments: [
      { start: 0.25, end: 1.5, text: "First fixture turn." },
      {
        start: 1.75,
        end: 3.125,
        text: "Second fixture turn.",
        speaker: "agent",
        speakerConfidence: 0.92,
      },
    ],
  });

  assert.deepEqual(transcript, {
    text: "First fixture turn. Second fixture turn.",
    segments: [
      {
        segmentId: "seg_000001",
        startMs: 250,
        endMs: 1500,
        text: "First fixture turn.",
        speaker: "unknown",
        speakerConfidence: null,
      },
      {
        segmentId: "seg_000002",
        startMs: 1750,
        endMs: 3125,
        text: "Second fixture turn.",
        speaker: "agent",
        speakerConfidence: 0.92,
      },
    ],
  });
});

test("flattened-only transcripts fail closed", () => {
  assert.throws(
    () => normalizeTimestampedTranscript({ text: "No timing evidence." }),
    (error) =>
      error?.code === "TRAINER_CALL_REVIEW_TIMESTAMPS_REQUIRED" &&
      !Object.hasOwn(error, "text"),
  );
});

test("invalid, overlapping-order, and empty segments are rejected", () => {
  for (const segments of [
    [{ start: -1, end: 1, text: "invalid" }],
    [{ start: 2, end: 1, text: "invalid" }],
    [
      { start: 2, end: 3, text: "later" },
      { start: 1, end: 2, text: "earlier" },
    ],
    [{ start: 0, end: 1, text: "  " }],
  ]) {
    assert.throws(() => normalizeTimestampedTranscript({ segments }));
  }
});

test("Coach findings must cite existing timestamped segments", () => {
  const transcript = normalizeTimestampedTranscript({
    segments: [
      { startMs: 0, endMs: 1000, text: "Fixture evidence." },
      { startMs: 1100, endMs: 2100, text: "More fixture evidence." },
    ],
  });
  assert.equal(
    assertEvidenceCitations(
      [
        {
          ruleId: "test-only.consider-listening",
          segmentIds: ["seg_000001", "seg_000002"],
        },
      ],
      transcript,
    ),
    true,
  );
  assert.throws(
    () =>
      assertEvidenceCitations(
        [{ ruleId: "test-only.invalid", segmentIds: ["seg_999999"] }],
        transcript,
      ),
    (error) => error?.code === "TRAINER_CALL_REVIEW_CITATION_INVALID",
  );
});
