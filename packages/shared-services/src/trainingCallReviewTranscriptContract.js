"use strict";

function contractError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asMilliseconds(segment, secondsKey, millisecondsKey) {
  if (segment[millisecondsKey] != null) {
    return Math.round(Number(segment[millisecondsKey]));
  }
  return Math.round(Number(segment[secondsKey]) * 1000);
}

function normalizeSpeaker(value) {
  const speaker = String(value || "").trim().toLowerCase();
  return ["agent", "prospect", "unknown"].includes(speaker)
    ? speaker
    : "unknown";
}

/**
 * Converts a provider/Whisper verbose transcript into immutable, citable
 * evidence. Unlike the legacy lead-quality helper, this contract refuses to
 * flatten away timestamps. It performs no diarization and treats unknown
 * speakers as unknown.
 */
function normalizeTimestampedTranscript(
  input,
  { maxSegments = 2_000, maxSegmentChars = 2_000 } = {},
) {
  const source = input && typeof input === "object" ? input : {};
  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  if (rawSegments.length === 0) {
    throw contractError(
      "Timestamped transcript segments are required",
      "TRAINER_CALL_REVIEW_TIMESTAMPS_REQUIRED",
    );
  }
  if (rawSegments.length > maxSegments) {
    throw contractError(
      "Transcript segment limit exceeded",
      "TRAINER_CALL_REVIEW_SEGMENT_LIMIT",
    );
  }

  let previousStartMs = -1;
  const segments = rawSegments.map((raw, index) => {
    const segment = raw && typeof raw === "object" ? raw : {};
    const startMs = asMilliseconds(segment, "start", "startMs");
    const endMs = asMilliseconds(segment, "end", "endMs");
    const text = String(segment.text || "").trim();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < startMs
    ) {
      throw contractError(
        `Invalid transcript timestamp at segment ${index + 1}`,
        "TRAINER_CALL_REVIEW_TIMESTAMP_INVALID",
      );
    }
    if (startMs < previousStartMs) {
      throw contractError(
        "Transcript segments must remain in chronological order",
        "TRAINER_CALL_REVIEW_SEGMENT_ORDER_INVALID",
      );
    }
    if (!text || text.length > maxSegmentChars) {
      throw contractError(
        `Invalid transcript text at segment ${index + 1}`,
        "TRAINER_CALL_REVIEW_SEGMENT_TEXT_INVALID",
      );
    }
    previousStartMs = startMs;
    const rawConfidence = Number(
      segment.speakerConfidence ?? segment.confidence,
    );
    const speakerConfidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : null;
    return Object.freeze({
      segmentId: `seg_${String(index + 1).padStart(6, "0")}`,
      startMs,
      endMs,
      text,
      speaker: normalizeSpeaker(segment.speaker ?? segment.speakerLabel),
      speakerConfidence,
    });
  });

  return Object.freeze({
    text: segments.map((segment) => segment.text).join(" "),
    segments: Object.freeze(segments),
  });
}

function assertEvidenceCitations(findings, transcript) {
  const knownSegments = new Set(
    Array.isArray(transcript?.segments)
      ? transcript.segments.map((segment) => segment.segmentId)
      : [],
  );
  if (knownSegments.size === 0) {
    throw contractError(
      "Timestamped transcript evidence is required",
      "TRAINER_CALL_REVIEW_EVIDENCE_REQUIRED",
    );
  }
  const rows = Array.isArray(findings) ? findings : [];
  for (const finding of rows) {
    const citations = Array.isArray(finding?.segmentIds)
      ? finding.segmentIds
      : [];
    if (
      citations.length === 0 ||
      citations.some((segmentId) => !knownSegments.has(segmentId))
    ) {
      throw contractError(
        "Every finding must cite existing transcript segments",
        "TRAINER_CALL_REVIEW_CITATION_INVALID",
      );
    }
  }
  return true;
}

module.exports = {
  assertEvidenceCitations,
  normalizeTimestampedTranscript,
};
