"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");

const trainingCallReviewRepository = require("../../shared-repositories/src/trainingCallReviewRepository");
const { TAX_GROUP_SCRIPT, TAX_GROUP_SECTIONS } = require("./taxGroupScript");
const {
  assertEvidenceCitations,
  normalizeTimestampedTranscript,
} = require("./trainingCallReviewTranscriptContract");

const DEFAULT_TRANSCRIPT_VERSION = "training-call-review-transcript-v1";
const DEFAULT_GRADER_VERSION = "training-call-review-grader-v1";
const DEFAULT_PROCESSING_LEASE_MS = 30 * 60 * 1000;
const SOURCE_PROVIDERS = new Set(["ex", "phoneburner", "callrail"]);
const SCRIPT_FINDING_STATUSES = new Set([
  "observed",
  "partial",
  "missed",
  "not_applicable",
  "uncertain",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function computeScriptVersion(
  script = TAX_GROUP_SCRIPT,
  sections = TAX_GROUP_SECTIONS,
) {
  return `tax-group-script-sha256:${sha256(
    JSON.stringify({ script, sections }),
  )}`;
}

const DEFAULT_SCRIPT_VERSION = computeScriptVersion();

function analysisError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class TrainingCallReviewAnalysisError extends Error {
  constructor(code, reviewId = null) {
    super("Call review analysis failed");
    this.name = "TrainingCallReviewAnalysisError";
    this.code = code || "TRAINER_CALL_REVIEW_ANALYSIS_FAILED";
    this.reviewId = reviewId ? String(reviewId) : null;
  }
}

function requiredString(value, field, maxLength = 256) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw analysisError(
      `${field} is required`,
      "TRAINER_CALL_REVIEW_INPUT_INVALID",
    );
  }
  return normalized;
}

function optionalString(value, maxLength = 512) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeLearnerKey(value) {
  return requiredString(value, "learnerKey", 320).toLowerCase();
}

function normalizeSource(input) {
  const source = input && typeof input === "object" ? input : {};
  const provider = requiredString(source.provider, "source.provider", 32)
    .toLowerCase();
  if (!SOURCE_PROVIDERS.has(provider)) {
    throw analysisError(
      "source.provider is unsupported",
      "TRAINER_CALL_REVIEW_INPUT_INVALID",
    );
  }
  const caseId = Number(source.caseId);
  if (!Number.isSafeInteger(caseId) || caseId <= 0) {
    throw analysisError(
      "source.caseId is invalid",
      "TRAINER_CALL_REVIEW_INPUT_INVALID",
    );
  }
  const durationSec = source.durationSec == null
    ? null
    : Math.round(Number(source.durationSec));
  if (
    durationSec != null &&
    (!Number.isFinite(durationSec) || durationSec < 0)
  ) {
    throw analysisError(
      "source.durationSec is invalid",
      "TRAINER_CALL_REVIEW_INPUT_INVALID",
    );
  }
  const startedAt = source.startedAt == null
    ? null
    : new Date(source.startedAt);
  if (startedAt && !Number.isFinite(startedAt.getTime())) {
    throw analysisError(
      "source.startedAt is invalid",
      "TRAINER_CALL_REVIEW_INPUT_INVALID",
    );
  }
  return Object.freeze({
    domain: requiredString(source.domain, "source.domain", 32).toUpperCase(),
    caseId,
    provider,
    callFingerprint: requiredString(
      source.callFingerprint,
      "source.callFingerprint",
      256,
    ),
    recordingFingerprint: requiredString(
      source.recordingFingerprint,
      "source.recordingFingerprint",
      256,
    ),
    sourceId: optionalString(source.sourceId, 200),
    startedAt,
    durationSec,
    direction: optionalString(source.direction, 32) || "unknown",
    agentName: optionalString(source.agentName, 200),
    outcome: optionalString(source.outcome, 200),
  });
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw analysisError(
      "Clock returned an invalid date",
      "TRAINER_CALL_REVIEW_CLOCK_INVALID",
    );
  }
  return date;
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(1, Math.max(0, number))
    : null;
}

function normalizeSegmentIds(value) {
  const ids = Array.isArray(value) ? value : [];
  return [...new Set(ids.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 12);
}

function buildScriptCatalog(sections) {
  const catalog = new Map();
  for (const section of sections) {
    const sectionId = String(section?.id || "").trim();
    if (!sectionId || catalog.has(sectionId)) {
      throw analysisError(
        "Tax Group script sections are invalid",
        "TRAINER_CALL_REVIEW_SCRIPT_INVALID",
      );
    }
    const beats = new Map();
    for (const beat of Array.isArray(section?.beats) ? section.beats : []) {
      const beatId = String(beat?.id || "").trim();
      if (!beatId || beats.has(beatId)) {
        throw analysisError(
          "Tax Group script beats are invalid",
          "TRAINER_CALL_REVIEW_SCRIPT_INVALID",
        );
      }
      beats.set(beatId, beat);
    }
    catalog.set(sectionId, { section, beats });
  }
  return catalog;
}

function buildCitations(segmentIds, transcript) {
  const byId = new Map(
    transcript.segments.map((segment) => [segment.segmentId, segment]),
  );
  return segmentIds.map((segmentId) => {
    const segment = byId.get(segmentId);
    return {
      segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      quote: segment.text,
    };
  });
}

function normalizeAnalysisOutput(rawInput, transcript, sections = TAX_GROUP_SECTIONS) {
  const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
  const rawScriptFindings = Array.isArray(raw.scriptFindings)
    ? raw.scriptFindings
    : [];
  if (rawScriptFindings.length === 0) {
    throw analysisError(
      "At least one script finding is required",
      "TRAINER_CALL_REVIEW_SCRIPT_FINDINGS_REQUIRED",
    );
  }
  if (rawScriptFindings.length > 100) {
    throw analysisError(
      "Script finding limit exceeded",
      "TRAINER_CALL_REVIEW_FINDING_LIMIT",
    );
  }
  const rawThingsToConsider = Array.isArray(raw.thingsToConsider)
    ? raw.thingsToConsider
    : [];
  if (rawThingsToConsider.length > 50) {
    throw analysisError(
      "Things-to-consider limit exceeded",
      "TRAINER_CALL_REVIEW_FINDING_LIMIT",
    );
  }

  const scriptCatalog = buildScriptCatalog(sections);
  const seenFindingIds = new Set();

  const scriptEvidenceRows = rawScriptFindings.map((finding, index) => {
    const findingId = requiredString(
      finding?.findingId || `script_${index + 1}`,
      "scriptFindings.findingId",
      120,
    );
    if (seenFindingIds.has(findingId)) {
      throw analysisError(
        "Finding IDs must be unique",
        "TRAINER_CALL_REVIEW_FINDING_ID_DUPLICATE",
      );
    }
    seenFindingIds.add(findingId);
    const sectionId = requiredString(
      finding?.sectionId,
      "scriptFindings.sectionId",
      32,
    );
    const beatId = requiredString(
      finding?.beatId,
      "scriptFindings.beatId",
      120,
    );
    const section = scriptCatalog.get(sectionId);
    if (!section?.beats.has(beatId)) {
      throw analysisError(
        "Script finding references an unknown Tax Group beat",
        "TRAINER_CALL_REVIEW_SCRIPT_CITATION_INVALID",
      );
    }
    const status = requiredString(
      finding?.status,
      "scriptFindings.status",
      32,
    ).toLowerCase();
    if (!SCRIPT_FINDING_STATUSES.has(status)) {
      throw analysisError(
        "Script finding status is invalid",
        "TRAINER_CALL_REVIEW_SCRIPT_FINDING_INVALID",
      );
    }
    return {
      findingId,
      sectionId,
      beatId,
      status,
      title: requiredString(finding?.title, "scriptFindings.title", 240),
      summary: requiredString(finding?.summary, "scriptFindings.summary", 2_000),
      confidence: clampConfidence(finding?.confidence),
      segmentIds: normalizeSegmentIds(finding?.segmentIds),
    };
  });

  const considerationEvidenceRows = rawThingsToConsider.map((finding, index) => {
    const findingId = requiredString(
      finding?.findingId || `consider_${index + 1}`,
      "thingsToConsider.findingId",
      120,
    );
    if (seenFindingIds.has(findingId)) {
      throw analysisError(
        "Finding IDs must be unique",
        "TRAINER_CALL_REVIEW_FINDING_ID_DUPLICATE",
      );
    }
    seenFindingIds.add(findingId);
    return {
      findingId,
      title: requiredString(finding?.title, "thingsToConsider.title", 240),
      summary: requiredString(
        finding?.summary,
        "thingsToConsider.summary",
        2_000,
      ),
      confidence: clampConfidence(finding?.confidence),
      segmentIds: normalizeSegmentIds(finding?.segmentIds),
    };
  });

  assertEvidenceCitations(
    [...scriptEvidenceRows, ...considerationEvidenceRows],
    transcript,
  );
  const confidentAgentSegmentIds = new Set(
    transcript.segments
      .filter(
        (segment) =>
          segment.speaker === "agent" &&
          Number(segment.speakerConfidence) >= 0.8,
      )
      .map((segment) => segment.segmentId),
  );

  return {
    authorityType: "tax_group_script",
    provider: optionalString(raw.provider, 80),
    model: optionalString(raw.model, 160),
    scriptFindings: scriptEvidenceRows.map((finding) => ({
      findingId: finding.findingId,
      sectionId: finding.sectionId,
      beatId: finding.beatId,
      status: finding.segmentIds.some((segmentId) =>
        confidentAgentSegmentIds.has(segmentId))
        ? finding.status : "uncertain",
      title: finding.title,
      summary: finding.summary,
      confidence: finding.confidence,
      citations: buildCitations(finding.segmentIds, transcript),
    })),
    thingsToConsider: considerationEvidenceRows.map((finding) => ({
      findingId: finding.findingId,
      authority: "model_generated_advisory",
      title: finding.title,
      summary: finding.summary,
      confidence: finding.confidence,
      citations: buildCitations(finding.segmentIds, transcript),
    })),
  };
}

function normalizeTranscriptPayload(
  rawTranscript,
  {
    recordingFingerprint,
    transcriptVersion,
    completedAt,
    reused = false,
    reusedFromReviewId = null,
  },
) {
  const normalized = normalizeTimestampedTranscript(rawTranscript);
  return {
    status: "completed",
    version: transcriptVersion,
    recordingFingerprint,
    text: normalized.text,
    segments: normalized.segments,
    provider: optionalString(rawTranscript?.provider, 80),
    model: optionalString(rawTranscript?.model, 160),
    reused,
    reusedFromReviewId: reusedFromReviewId || null,
    completedAt,
  };
}

async function defaultCleanupArtifact(artifact) {
  if (!artifact) return;
  if (typeof artifact.cleanup === "function") {
    await artifact.cleanup();
    return;
  }
  if (artifact.path) {
    await fs.rm(String(artifact.path), { force: true });
  }
}

function safeFailureCode(error) {
  const code = String(error?.code || "TRAINER_CALL_REVIEW_ANALYSIS_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_")
    .slice(0, 120);
  return code || "TRAINER_CALL_REVIEW_ANALYSIS_FAILED";
}

function toPublicReview(review) {
  if (!review) return null;
  const transcript = review.transcript?.status === "completed"
    ? {
        status: "completed",
        version: review.transcript.version,
        reused: Boolean(review.transcript.reused),
        segments: Array.isArray(review.transcript.segments)
          ? review.transcript.segments.map((segment) => ({
              segmentId: segment.segmentId,
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text,
              speaker: segment.speaker,
              speakerConfidence: segment.speakerConfidence ?? null,
            }))
          : [],
      }
    : { status: review.transcript?.status || "pending" };
  return {
    reviewId: String(review._id || review.id || ""),
    status: review.status,
    generation: Number(review.generation || 0),
    versions: {
      scriptVersion: review.versions?.scriptVersion || null,
      transcriptVersion: review.versions?.transcriptVersion || null,
      graderVersion: review.versions?.graderVersion || null,
    },
    source: {
      provider: review.source?.provider || null,
      startedAt: review.source?.startedAt || null,
      durationSec: review.source?.durationSec ?? null,
      direction: review.source?.direction || "unknown",
      agentName: review.source?.agentName || null,
      outcome: review.source?.outcome || null,
    },
    transcript,
    scriptFindings: Array.isArray(review.analysis?.scriptFindings)
      ? review.analysis.scriptFindings
      : [],
    thingsToConsider: Array.isArray(review.analysis?.thingsToConsider)
      ? review.analysis.thingsToConsider
      : [],
    createdAt: review.createdAt || null,
    startedAt: review.startedAt || null,
    completedAt: review.completedAt || null,
    errorCode: review.status === "failed" ? review.error?.code || null : null,
  };
}

function createTrainingCallReviewAnalysisService({
  repository = trainingCallReviewRepository,
  downloadRecording,
  transcribeRecording,
  gradeCallReview,
  cleanupArtifact = defaultCleanupArtifact,
  now = () => new Date(),
  transcriptVersion = DEFAULT_TRANSCRIPT_VERSION,
  graderVersion = DEFAULT_GRADER_VERSION,
  script = TAX_GROUP_SCRIPT,
  sections = TAX_GROUP_SECTIONS,
  scriptVersion = null,
  processingLeaseMs = DEFAULT_PROCESSING_LEASE_MS,
} = {}) {
  if (typeof downloadRecording !== "function") {
    throw new TypeError("downloadRecording dependency is required");
  }
  if (typeof transcribeRecording !== "function") {
    throw new TypeError("transcribeRecording dependency is required");
  }
  if (typeof gradeCallReview !== "function") {
    throw new TypeError("gradeCallReview dependency is required");
  }
  const effectiveTranscriptVersion = requiredString(
    transcriptVersion,
    "transcriptVersion",
    160,
  );
  const effectiveGraderVersion = requiredString(
    graderVersion,
    "graderVersion",
    160,
  );
  const effectiveScriptVersion = requiredString(
    scriptVersion || computeScriptVersion(script, sections),
    "scriptVersion",
    160,
  );
  const effectiveProcessingLeaseMs = Math.max(
    1_000,
    Math.min(
      Number(processingLeaseMs) || DEFAULT_PROCESSING_LEASE_MS,
      24 * 60 * 60 * 1000,
    ),
  );
  buildScriptCatalog(sections);

  async function transcribeNewArtifact({ reviewId, source }) {
    let artifact = null;
    let primaryError = null;
    try {
      artifact = await downloadRecording({
        reviewId: String(reviewId),
        source,
        recordingFingerprint: source.recordingFingerprint,
      });
      if (!artifact || typeof artifact !== "object") {
        throw analysisError(
          "Recording downloader returned no artifact",
          "TRAINER_CALL_REVIEW_RECORDING_ARTIFACT_INVALID",
        );
      }
      return await transcribeRecording({
        artifact,
        source,
        transcriptVersion: effectiveTranscriptVersion,
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (artifact) {
        try {
          await cleanupArtifact(artifact);
        } catch (cleanupError) {
          if (!primaryError) {
            throw analysisError(
              "Temporary recording cleanup failed",
              cleanupError?.code || "TRAINER_CALL_REVIEW_TEMP_CLEANUP_FAILED",
            );
          }
        }
      }
    }
  }

  async function analyzeCallReview({
    learnerKey: rawLearnerKey,
    source: rawSource,
    requestId = null,
  } = {}) {
    const learnerKey = normalizeLearnerKey(rawLearnerKey);
    const source = normalizeSource(rawSource);
    const clockNow = asDate(now());
    const key = {
      learnerKey,
      callFingerprint: source.callFingerprint,
      recordingFingerprint: source.recordingFingerprint,
      scriptVersion: effectiveScriptVersion,
      transcriptVersion: effectiveTranscriptVersion,
      graderVersion: effectiveGraderVersion,
    };
    const created = await repository.findOrCreateReview({
      key,
      create: {
        learnerKey,
        callFingerprint: source.callFingerprint,
        recordingFingerprint: source.recordingFingerprint,
        recordingSourceId: source.sourceId,
        domain: source.domain,
        caseId: source.caseId,
        source: {
          provider: source.provider,
          startedAt: source.startedAt,
          durationSec: source.durationSec,
          direction: source.direction,
          agentName: source.agentName,
          outcome: source.outcome,
        },
        versions: {
          scriptVersion: effectiveScriptVersion,
          transcriptVersion: effectiveTranscriptVersion,
          graderVersion: effectiveGraderVersion,
        },
        requestId: optionalString(requestId, 160),
        status: "pending",
        generation: 0,
      },
    });
    if (!created) {
      throw new TrainingCallReviewAnalysisError(
        "TRAINER_CALL_REVIEW_PERSISTENCE_FAILED",
      );
    }
    if (created.status === "completed") {
      return toPublicReview(created);
    }

    const claimed = await repository.claimReview(
      created._id,
      clockNow,
      { processingLeaseMs: effectiveProcessingLeaseMs },
    );
    if (!claimed) {
      const current = await repository.findReviewById(created._id);
      if (current) return toPublicReview(current);
      throw new TrainingCallReviewAnalysisError(
        "TRAINER_CALL_REVIEW_CLAIM_LOST",
        created._id,
      );
    }

    const reviewId = claimed._id;
    const generation = claimed.generation;
    try {
      const reusable = claimed.transcript?.status === "completed"
        ? claimed
        : await repository.findReusableTranscript({
            recordingFingerprint: source.recordingFingerprint,
            transcriptVersion: effectiveTranscriptVersion,
            excludeReviewId: reviewId,
          });
      const transcriptCompletedAt = asDate(now());
      let transcript;
      if (reusable?.transcript?.status === "completed") {
        transcript = normalizeTranscriptPayload(reusable.transcript, {
          recordingFingerprint: source.recordingFingerprint,
          transcriptVersion: effectiveTranscriptVersion,
          completedAt: transcriptCompletedAt,
          reused: true,
          reusedFromReviewId: reusable._id,
        });
      } else {
        const rawTranscript = await transcribeNewArtifact({ reviewId, source });
        transcript = normalizeTranscriptPayload(rawTranscript, {
          recordingFingerprint: source.recordingFingerprint,
          transcriptVersion: effectiveTranscriptVersion,
          completedAt: transcriptCompletedAt,
        });
      }

      const transcriptSaved = await repository.saveTranscript(
        reviewId,
        generation,
        transcript,
      );
      if (!transcriptSaved) {
        throw analysisError(
          "Review generation changed while saving transcript",
          "TRAINER_CALL_REVIEW_STALE_GENERATION",
        );
      }

      const rawAnalysis = await gradeCallReview({
        transcript: {
          text: transcript.text,
          segments: transcript.segments,
        },
        source,
        authority: {
          type: "tax_group_script",
          version: effectiveScriptVersion,
          script,
          sections: JSON.parse(JSON.stringify(sections)),
        },
        versions: {
          transcriptVersion: effectiveTranscriptVersion,
          graderVersion: effectiveGraderVersion,
        },
      });
      const normalizedAnalysis = normalizeAnalysisOutput(
        rawAnalysis,
        transcript,
        sections,
      );
      const analysis = {
        ...normalizedAnalysis,
        scriptVersion: effectiveScriptVersion,
        graderVersion: effectiveGraderVersion,
      };
      const completed = await repository.completeReview(reviewId, generation, {
        analysis,
        completedAt: asDate(now()),
      });
      if (!completed) {
        throw analysisError(
          "Review generation changed while saving analysis",
          "TRAINER_CALL_REVIEW_STALE_GENERATION",
        );
      }
      return toPublicReview(completed);
    } catch (error) {
      const code = safeFailureCode(error);
      try {
        await repository.failReview(reviewId, generation, {
          code,
          failedAt: asDate(now()),
        });
      } catch {
        // Preserve the original safe error code. Persistence diagnostics belong
        // in server-side observability, not the learner-facing response.
      }
      throw new TrainingCallReviewAnalysisError(code, reviewId);
    }
  }

  async function getReview(reviewId) {
    return toPublicReview(await repository.findReviewById(reviewId));
  }

  return Object.freeze({
    analyzeCallReview,
    getReview,
    versions: Object.freeze({
      scriptVersion: effectiveScriptVersion,
      transcriptVersion: effectiveTranscriptVersion,
      graderVersion: effectiveGraderVersion,
    }),
  });
}

module.exports = {
  DEFAULT_PROCESSING_LEASE_MS,
  DEFAULT_GRADER_VERSION,
  DEFAULT_SCRIPT_VERSION,
  DEFAULT_TRANSCRIPT_VERSION,
  TrainingCallReviewAnalysisError,
  computeScriptVersion,
  createTrainingCallReviewAnalysisService,
  normalizeAnalysisOutput,
  toPublicReview,
};
