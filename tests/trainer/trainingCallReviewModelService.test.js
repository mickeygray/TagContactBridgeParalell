"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  TrainingCallReviewModelError,
  buildGradingTool,
  createTrainingCallReviewModelService,
  taxGroupScriptVersion,
} = require("../../packages/shared-services/src/trainingCallReviewModelService");
const {
  TAX_GROUP_SCRIPT,
  TAX_GROUP_SECTIONS,
} = require("../../packages/shared-services/src/taxGroupScript");

async function makeArtifact(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trainer-model-test-"));
  const filePath = path.join(root, "fixture.wav");
  await fs.writeFile(filePath, Buffer.from("synthetic audio fixture"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    path: filePath,
    mimeType: "audio/wav",
  };
}

function timestampedTranscript() {
  return {
    text: "May I ask a few questions? Yes.",
    segments: [
      {
        segmentId: "seg_000001",
        startMs: 250,
        endMs: 1_500,
        text: "May I ask a few questions?",
        speaker: "agent",
        speakerConfidence: 0.94,
      },
      {
        segmentId: "seg_000002",
        startMs: 1_600,
        endMs: 2_100,
        text: "Yes.",
        speaker: "prospect",
        speakerConfidence: 0.9,
      },
    ],
  };
}

function structuredGrade() {
  return {
    scriptFindings: [
      {
        findingId: "script.ask_permission",
        sectionId: "2",
        beatId: "ask_permission",
        status: "observed",
        title: "Asked permission",
        summary: "The agent asked permission before discovery.",
        confidence: 0.95,
        segmentIds: ["seg_000001"],
      },
    ],
    thingsToConsider: [
      {
        findingId: "consider.pause",
        title: "Consider a longer pause",
        summary: "A longer pause may give the prospect more room.",
        confidence: 0.58,
        segmentIds: ["seg_000001", "seg_000002"],
      },
    ],
  };
}

test("Whisper request is verbose timestamped and preserves every segment", async (t) => {
  const artifact = await makeArtifact(t);
  let request = null;
  const service = createTrainingCallReviewModelService({
    openAiApiKey: "synthetic-openai-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          text: "Flattened text is not authoritative.",
          language: "en",
          duration: 3.25,
          segments: [
            { start: 0.125, end: 1.25, text: " First timestamped turn. " },
            { start: 1.5, end: 3.125, text: "Second timestamped turn." },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    createAnthropicClientImpl: () => ({
      async createMessage() {
        throw new Error("grader is not used in this test");
      },
    }),
  });

  const transcript = await service.transcribeRecording({ artifact });
  assert.equal(
    request.url,
    "https://api.openai.com/v1/audio/transcriptions",
  );
  assert.equal(
    request.options.headers.Authorization,
    "Bearer synthetic-openai-key",
  );
  assert.equal(request.options.body.get("model"), "whisper-1");
  assert.equal(request.options.body.get("response_format"), "verbose_json");
  assert.equal(
    request.options.body.get("timestamp_granularities[]"),
    "segment",
  );
  assert.deepEqual(transcript, {
    text: "First timestamped turn. Second timestamped turn.",
    segments: [
      {
        start: 0.125,
        end: 1.25,
        text: "First timestamped turn.",
        speaker: "unknown",
        speakerConfidence: null,
      },
      {
        start: 1.5,
        end: 3.125,
        text: "Second timestamped turn.",
        speaker: "unknown",
        speakerConfidence: null,
      },
    ],
    language: "en",
    durationSec: 3.25,
    provider: "openai",
    model: "whisper-1",
  });
});

test("grading uses TAX_GROUP_SCRIPT and TAX_GROUP_SECTIONS as sole authority and returns the analysis-service shape", async () => {
  let request = null;
  const service = createTrainingCallReviewModelService({
    openAiApiKey: "synthetic-openai-key",
    fetchImpl: async () => {
      throw new Error("transcriber is not used in this test");
    },
    createAnthropicClientImpl: () => ({
      async createMessage(input) {
        request = input;
        return {
          model: "synthetic-claude",
          content: [
            {
              type: "tool_use",
              name: "submit_training_call_review",
              input: structuredGrade(),
            },
          ],
        };
      },
    }),
  });

  const grade = await service.gradeCallReview({
    transcript: timestampedTranscript(),
    source: {
      provider: "ex",
      durationSec: 600,
      direction: "outbound",
      agentName: "Fixture Agent",
      outcome: "connected",
      rawCustomerPayload: "must-not-be-forwarded",
      phone: "555-867-5309",
    },
  });

  assert.ok(request.system.includes(TAX_GROUP_SCRIPT));
  assert.ok(request.system.includes(JSON.stringify(TAX_GROUP_SECTIONS)));
  assert.ok(request.system.includes(taxGroupScriptVersion()));
  assert.ok(request.messages[0].content.includes("seg_000001"));
  assert.equal(
    request.messages[0].content.includes("must-not-be-forwarded"),
    false,
  );
  assert.equal(request.messages[0].content.includes("555-867-5309"), false);
  assert.equal(request.tools[0].name, "submit_training_call_review");
  assert.deepEqual(grade, {
    ...structuredGrade(),
    provider: "anthropic",
    model: "synthetic-claude",
  });
  assert.deepEqual(service.versions, {
    scriptVersion: taxGroupScriptVersion(),
    transcriptVersion: "training-call-review-transcript-v1",
    graderVersion: "training-call-review-grader-v1",
    whisperModel: "whisper-1",
    graderModel: "claude-sonnet-5",
  });
});

test("grading schema keeps model advice explicitly under thingsToConsider", () => {
  const tool = buildGradingTool();
  assert.deepEqual(tool.input_schema.required, [
    "scriptFindings",
    "thingsToConsider",
  ]);
  assert.equal(
    Object.hasOwn(tool.input_schema.properties, "recommendations"),
    false,
  );
  assert.deepEqual(
    tool.input_schema.properties.scriptFindings.items.properties.sectionId.enum,
    TAX_GROUP_SECTIONS.map((section) => section.id),
  );
});

test("provider failures do not surface raw customer or provider payloads", async (t) => {
  const artifact = await makeArtifact(t);
  const transcriptionService = createTrainingCallReviewModelService({
    openAiApiKey: "synthetic-openai-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          customerSecret: "raw-customer-payload-must-stay-private",
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    createAnthropicClientImpl: () => ({
      async createMessage() {
        throw new Error("not used");
      },
    }),
  });
  await assert.rejects(
    transcriptionService.transcribeRecording({ artifact }),
    (error) =>
      error instanceof TrainingCallReviewModelError &&
      error.code === "TRAINER_CALL_REVIEW_TRANSCRIPTION_HTTP_FAILED" &&
      !error.message.includes("raw-customer-payload"),
  );

  const gradingService = createTrainingCallReviewModelService({
    openAiApiKey: "synthetic-openai-key",
    fetchImpl: async () => {
      throw new Error("not used");
    },
    createAnthropicClientImpl: () => ({
      async createMessage() {
        throw new Error("provider leaked raw-customer-payload-must-stay-private");
      },
    }),
  });
  await assert.rejects(
    gradingService.gradeCallReview({
      transcript: timestampedTranscript(),
      source: { provider: "callrail" },
    }),
    (error) =>
      error instanceof TrainingCallReviewModelError &&
      error.code === "TRAINER_CALL_REVIEW_GRADING_FAILED" &&
      !error.message.includes("raw-customer-payload"),
  );
});
