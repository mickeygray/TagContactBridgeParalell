"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const { env } = require("../../shared-config/src");
const {
  createAnthropicClient,
} = require("../../shared-integrations/src");
const { TAX_GROUP_SCRIPT, TAX_GROUP_SECTIONS } = require("./taxGroupScript");

const DEFAULT_WHISPER_MODEL = "whisper-1";
const DEFAULT_GRADER_MODEL = "claude-sonnet-5";
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const DEFAULT_GRADING_TIMEOUT_MS = 60_000;
const MAX_WHISPER_BYTES = 24 * 1024 * 1024;
const MAX_GRADING_TRANSCRIPT_CHARS = 400_000;

class TrainingCallReviewModelError extends Error {
  constructor(code, message = "Call review model request failed") {
    super(message);
    this.name = "TrainingCallReviewModelError";
    this.code = code;
  }
}

function modelError(code, message) {
  return new TrainingCallReviewModelError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function taxGroupScriptVersion() {
  return `tax-group-script-sha256:${sha256(
    JSON.stringify({
      script: TAX_GROUP_SCRIPT,
      sections: TAX_GROUP_SECTIONS,
    }),
  )}`;
}

function cleanMetadata(value, maxLength = 200) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${String(milliseconds).padStart(3, "0")}`;
}

function buildTranscriptEvidence(transcript) {
  const segments = Array.isArray(transcript?.segments)
    ? transcript.segments
    : [];
  if (segments.length === 0) {
    throw modelError(
      "TRAINER_CALL_REVIEW_TIMESTAMPS_REQUIRED",
      "Timestamped transcript segments are required",
    );
  }
  const lines = segments.map((segment) => {
    const segmentId = cleanMetadata(segment?.segmentId, 120);
    const text = String(segment?.text || "").trim();
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    if (
      !segmentId ||
      !text ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < startMs
    ) {
      throw modelError(
        "TRAINER_CALL_REVIEW_TRANSCRIPT_INVALID",
        "Timestamped transcript is invalid",
      );
    }
    const speaker = ["agent", "prospect"].includes(
      String(segment?.speaker || "").toLowerCase(),
    )
      ? String(segment.speaker).toLowerCase()
      : "unknown";
    const confidence = Number(segment?.speakerConfidence);
    const confidenceLabel = Number.isFinite(confidence)
      ? ` confidence=${Math.min(1, Math.max(0, confidence)).toFixed(2)}`
      : "";
    return `[${segmentId} ${formatTimestamp(startMs)}-${formatTimestamp(
      endMs,
    )} speaker=${speaker}${confidenceLabel}] ${text}`;
  });
  const evidence = lines.join("\n");
  if (evidence.length > MAX_GRADING_TRANSCRIPT_CHARS) {
    throw modelError(
      "TRAINER_CALL_REVIEW_TRANSCRIPT_TOO_LARGE",
      "Transcript exceeds the grading limit",
    );
  }
  return evidence;
}

function buildGradingTool() {
  const sectionIds = TAX_GROUP_SECTIONS.map((section) => section.id);
  const beatIds = TAX_GROUP_SECTIONS.flatMap((section) =>
    section.beats.map((beat) => beat.id),
  );
  const citationProperty = {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: { type: "string", pattern: "^seg_[0-9]{6}$" },
  };
  return {
    name: "submit_training_call_review",
    description:
      "Submit evidence-bound Tax Group script findings and separately labeled advisory things to consider.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["scriptFindings", "thingsToConsider"],
      properties: {
        scriptFindings: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "findingId",
              "sectionId",
              "beatId",
              "status",
              "title",
              "summary",
              "confidence",
              "segmentIds",
            ],
            properties: {
              findingId: { type: "string", maxLength: 120 },
              sectionId: { type: "string", enum: sectionIds },
              beatId: { type: "string", enum: beatIds },
              status: {
                type: "string",
                enum: [
                  "observed",
                  "partial",
                  "missed",
                  "not_applicable",
                  "uncertain",
                ],
              },
              title: { type: "string", maxLength: 240 },
              summary: { type: "string", maxLength: 2_000 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              segmentIds: citationProperty,
            },
          },
        },
        thingsToConsider: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "findingId",
              "title",
              "summary",
              "confidence",
              "segmentIds",
            ],
            properties: {
              findingId: { type: "string", maxLength: 120 },
              title: { type: "string", maxLength: 240 },
              summary: { type: "string", maxLength: 2_000 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              segmentIds: citationProperty,
            },
          },
        },
      },
    },
  };
}

function buildGradingSystemPrompt() {
  return [
    "You review a completed tax-resolution call for agent training.",
    "The Tax Group approved representation methodology below is the sole",
    "authoritative script. Only TAX_GROUP_SECTIONS beat IDs may support",
    "scriptFindings. Do not promote your own preferences into script rules.",
    "Anything useful that is not an explicit script beat belongs only in",
    "thingsToConsider and remains advisory model-generated guidance.",
    "Every finding must cite one or more exact transcript segment IDs.",
    "A script finding may be conclusive only when at least one cited segment",
    "is labeled agent with speakerConfidence >= 0.8. Otherwise set its",
    "status to uncertain. Do not infer agent conduct from unknown speakers.",
    "Do not invent quotes. Keep findings concrete and avoid",
    "customer-identifying details.",
    "Output only via submit_training_call_review.",
    "",
    `SCRIPT VERSION: ${taxGroupScriptVersion()}`,
    "",
    "TAX_GROUP_SCRIPT:",
    TAX_GROUP_SCRIPT,
    "",
    "TAX_GROUP_SECTIONS:",
    JSON.stringify(TAX_GROUP_SECTIONS),
  ].join("\n");
}

function buildGradingUserPrompt({ transcript, source }) {
  const metadata = {
    provider: cleanMetadata(source?.provider, 32),
    startedAt: source?.startedAt || null,
    durationSec: Number(source?.durationSec) || null,
    direction: cleanMetadata(source?.direction, 32),
    agentName: cleanMetadata(source?.agentName, 120),
    outcome: cleanMetadata(source?.outcome, 120),
  };
  return [
    `SAFE CALL METADATA: ${JSON.stringify(metadata)}`,
    "",
    "TIMESTAMPED TRANSCRIPT EVIDENCE:",
    buildTranscriptEvidence(transcript),
  ].join("\n");
}

function createTrainingCallReviewModelService({
  fetchImpl = globalThis.fetch,
  openAiApiKey = env("OPENAI_API_KEY", ""),
  whisperModel = DEFAULT_WHISPER_MODEL,
  graderModel = env("SALES_TRAINER_COACH_MODEL", DEFAULT_GRADER_MODEL),
  createAnthropicClientImpl = createAnthropicClient,
  transcriptionTimeoutMs = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  gradingTimeoutMs = DEFAULT_GRADING_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch implementation is required");
  }
  if (String(whisperModel) !== DEFAULT_WHISPER_MODEL) {
    throw new TypeError("Timestamped call review requires whisper-1");
  }
  const effectiveTranscriptionTimeout = Math.max(
    1_000,
    Math.min(
      Number(transcriptionTimeoutMs) || DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
      180_000,
    ),
  );
  const effectiveGradingTimeout = Math.max(
    1_000,
    Math.min(
      Number(gradingTimeoutMs) || DEFAULT_GRADING_TIMEOUT_MS,
      120_000,
    ),
  );

  async function transcribeRecording({ artifact } = {}) {
    const filePath = cleanMetadata(artifact?.path, 2_048);
    if (!filePath) {
      throw modelError(
        "TRAINER_CALL_REVIEW_ARTIFACT_REQUIRED",
        "Temporary recording artifact is required",
      );
    }
    if (!openAiApiKey) {
      throw modelError(
        "TRAINER_CALL_REVIEW_OPENAI_NOT_CONFIGURED",
        "Call review transcription is not configured",
      );
    }
    let file;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WHISPER_BYTES) {
        throw modelError(
          "TRAINER_CALL_REVIEW_ARTIFACT_SIZE_INVALID",
          "Temporary recording artifact size is invalid",
        );
      }
      file = await fs.readFile(filePath);
    } catch (error) {
      if (error instanceof TrainingCallReviewModelError) throw error;
      throw modelError(
        "TRAINER_CALL_REVIEW_ARTIFACT_READ_FAILED",
        "Temporary recording artifact could not be read",
      );
    }

    const mimeType =
      cleanMetadata(artifact?.mimeType, 120) || "application/octet-stream";
    const form = new FormData();
    form.append("file", new Blob([file], { type: mimeType }), path.basename(filePath));
    form.append("model", DEFAULT_WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("temperature", "0");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      effectiveTranscriptionTimeout,
    );
    let response;
    try {
      response = await fetchImpl(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${openAiApiKey}` },
          body: form,
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw modelError(
          "TRAINER_CALL_REVIEW_TRANSCRIPTION_TIMEOUT",
          "Call review transcription timed out",
        );
      }
      throw modelError(
        "TRAINER_CALL_REVIEW_TRANSCRIPTION_FETCH_FAILED",
        "Call review transcription request failed",
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw modelError(
        "TRAINER_CALL_REVIEW_TRANSCRIPTION_HTTP_FAILED",
        `Call review transcription returned HTTP ${Number(response.status) || 0}`,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw modelError(
        "TRAINER_CALL_REVIEW_TRANSCRIPTION_RESPONSE_INVALID",
        "Call review transcription response was invalid",
      );
    }
    const rawSegments = Array.isArray(payload?.segments)
      ? payload.segments
      : [];
    if (rawSegments.length === 0) {
      throw modelError(
        "TRAINER_CALL_REVIEW_TIMESTAMPS_REQUIRED",
        "Call review transcription returned no timestamped segments",
      );
    }
    const segments = rawSegments.map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end),
      text: String(segment?.text || "").trim(),
      speaker: "unknown",
      speakerConfidence: null,
    }));
    return {
      text: segments.map((segment) => segment.text).join(" ").trim(),
      segments,
      language: cleanMetadata(payload?.language, 40),
      durationSec: Number(payload?.duration) || null,
      provider: "openai",
      model: DEFAULT_WHISPER_MODEL,
    };
  }

  async function gradeCallReview({ transcript, source } = {}) {
    const client = createAnthropicClientImpl();
    const tool = buildGradingTool();
    let response;
    try {
      response = await client.createMessage({
        system: buildGradingSystemPrompt(),
        messages: [
          {
            role: "user",
            content: buildGradingUserPrompt({ transcript, source }),
          },
        ],
        model: graderModel || DEFAULT_GRADER_MODEL,
        maxTokens: 6_000,
        temperature: 0,
        tools: [tool],
        toolChoice: { type: "tool", name: tool.name },
        timeoutMs: effectiveGradingTimeout,
      });
    } catch {
      throw modelError(
        "TRAINER_CALL_REVIEW_GRADING_FAILED",
        "Call review grading request failed",
      );
    }
    const toolUse = (Array.isArray(response?.content) ? response.content : [])
      .find(
        (block) =>
          block?.type === "tool_use" &&
          block?.name === "submit_training_call_review",
      );
    if (!toolUse?.input || typeof toolUse.input !== "object") {
      throw modelError(
        "TRAINER_CALL_REVIEW_GRADING_RESPONSE_INVALID",
        "Call review grader returned no structured analysis",
      );
    }
    return {
      ...toolUse.input,
      provider: "anthropic",
      model: cleanMetadata(response?.model, 160) ||
        cleanMetadata(graderModel, 160),
    };
  }

  return Object.freeze({
    gradeCallReview,
    transcribeRecording,
    versions: Object.freeze({
      scriptVersion: taxGroupScriptVersion(),
      transcriptVersion: "training-call-review-transcript-v1",
      graderVersion: "training-call-review-grader-v1",
      whisperModel: DEFAULT_WHISPER_MODEL,
      graderModel: graderModel || DEFAULT_GRADER_MODEL,
    }),
  });
}

module.exports = {
  DEFAULT_GRADER_MODEL,
  DEFAULT_GRADING_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_WHISPER_MODEL,
  MAX_GRADING_TRANSCRIPT_CHARS,
  MAX_WHISPER_BYTES,
  TrainingCallReviewModelError,
  buildGradingSystemPrompt,
  buildGradingTool,
  buildGradingUserPrompt,
  buildTranscriptEvidence,
  createTrainingCallReviewModelService,
  taxGroupScriptVersion,
};
