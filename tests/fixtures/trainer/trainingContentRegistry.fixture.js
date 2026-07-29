"use strict";

// Synthetic mechanics-only content. It does not state or publish company
// doctrine and is accepted only when a test explicitly enables test content.
function buildValidTrainingContentFixture() {
  return {
    id: "fixture-content-bundle",
    version: "1.0.0-test",
    status: "published",
    testOnly: true,
    ruleRegistry: {
      id: "fixture-rule-registry",
      version: "1.0.0-test",
      status: "published",
      rules: [
        {
          id: "fixture-rule-alpha",
          version: "1.0.0-test",
          status: "published",
          authority: {
            type: "test-fixture",
            citations: ["tests/fixtures/trainer/trainingContentRegistry.fixture.js#alpha"],
          },
        },
        {
          id: "fixture-rule-beta",
          version: "1.0.0-test",
          status: "published",
          authority: {
            type: "test-fixture",
            citations: ["tests/fixtures/trainer/trainingContentRegistry.fixture.js#beta"],
          },
        },
      ],
    },
    courseManifest: {
      id: "fixture-course",
      version: "1.0.0-test",
      status: "published",
      items: [
        {
          id: "fixture-item-learn",
          version: "1.0.0-test",
          status: "published",
          type: "lesson",
          ruleIds: ["fixture-rule-alpha"],
          prerequisiteItemIds: [],
        },
        {
          id: "fixture-item-practice",
          version: "1.0.0-test",
          status: "published",
          type: "quiz",
          ruleIds: ["fixture-rule-alpha", "fixture-rule-beta"],
          prerequisiteItemIds: ["fixture-item-learn"],
          presentation: {
            title: "Fixture quiz",
            prompt: "Choose the fixture answer.",
            choices: [
              { choiceId: "fixture-correct", label: "Fixture correct" },
              { choiceId: "fixture-retry", label: "Fixture retry" },
            ],
          },
          assessment: {
            version: "1.0.0-test",
            canonicalAnswer: "fixture-correct",
            acceptedAnswers: [],
          },
          grading: {
            required: true,
            deterministic: true,
            ruleIds: ["fixture-rule-alpha"],
          },
        },
      ],
      overlays: [
        {
          id: "fixture-overlay-inbound",
          version: "1.0.0-test",
          status: "published",
          scope: {
            company: "FIXTURE_ONLY",
            direction: "inbound",
          },
          itemOverrides: [
            {
              itemId: "fixture-item-practice",
              ruleIds: ["fixture-rule-beta"],
            },
          ],
        },
      ],
    },
    scenarioBlueprints: [
      {
        id: "fixture-scenario",
        version: "1.0.0-test",
        status: "published",
        experienceMode: "gauntlet",
        sectionId: "fixture-section-listen-clarify",
        direction: "inbound",
        localObjective: "Acknowledge a synthetic concern and ask one clarifying question.",
        deliveryMode: "text-only-test",
        maxTurns: 4,
        maxVisitsPerNode: 2,
        startNodeId: "fixture-node-start",
        ruleIds: ["fixture-rule-alpha"],
        prohibitedSpeechActs: ["quote-price", "close-sale"],
        retryPolicy: {
          nodeRetryLimit: 1,
          runRetryLimit: 1,
          variantStrategy: "unused-first",
        },
        hintPolicy: { steps: [] },
        audioManifest: {
          id: "fixture-audio-manifest",
          version: "1.0.0-test",
          requiredTargetIds: [],
        },
        variants: [
          {
            variantId: "fixture-variant-calm",
            version: "1.0.0-test",
            personaProfileId: "fixture-persona-calm",
            factSetId: "fixture-facts-a",
            utteranceSetIds: ["fixture-utterances-calm"],
            voiceProfileId: "fixture-voice-calm",
            requiredAudioTargetIds: [],
          },
          {
            variantId: "fixture-variant-direct",
            version: "1.0.0-test",
            personaProfileId: "fixture-persona-direct",
            factSetId: "fixture-facts-b",
            utteranceSetIds: ["fixture-utterances-direct"],
            voiceProfileId: "fixture-voice-direct",
            requiredAudioTargetIds: [],
          },
        ],
        nodes: [
          {
            id: "fixture-node-start",
            version: "1.0.0-test",
            type: "prospect",
            sectionId: "fixture-section-listen-clarify",
            reactionIntent: "State a synthetic concern without advancing the call.",
            allowedSpeechActs: ["raise-concern"],
            requiredCriteria: [],
            ruleIds: ["fixture-rule-alpha"],
          },
          {
            id: "fixture-node-check",
            version: "1.0.0-test",
            type: "checkpoint",
            sectionId: "fixture-section-listen-clarify",
            reactionIntent: "React to the learner's acknowledgement and clarification.",
            allowedSpeechActs: ["answer-clarification"],
            requiredCriteria: [
              {
                criterionId: "fixture-criterion-acknowledge",
                ruleId: "fixture-rule-alpha",
                ruleRevision: "1.0.0-test",
                detector: "semantic",
                required: true,
              },
              {
                criterionId: "fixture-criterion-clarify",
                ruleId: "fixture-rule-beta",
                ruleRevision: "1.0.0-test",
                detector: "semantic",
                required: true,
              },
            ],
            ruleIds: ["fixture-rule-alpha", "fixture-rule-beta"],
            gate: {
              required: true,
              deterministic: true,
              ruleIds: ["fixture-rule-alpha"],
            },
          },
          {
            id: "fixture-node-terminal",
            version: "1.0.0-test",
            type: "terminal",
            sectionId: "fixture-section-listen-clarify",
            reactionIntent: "",
            allowedSpeechActs: [],
            requiredCriteria: [],
            ruleIds: [],
          },
        ],
        edges: [
          {
            id: "fixture-edge-open",
            version: "1.0.0-test",
            from: "fixture-node-start",
            to: "fixture-node-check",
            priority: 10,
            condition: {
              fact: "turn_count",
              op: "gte",
              value: 1,
            },
          },
          {
            id: "fixture-edge-start-fallback",
            version: "1.0.0-test",
            from: "fixture-node-start",
            to: "fixture-node-terminal",
            priority: 99,
            fallback: true,
          },
          {
            id: "fixture-edge-finish",
            version: "1.0.0-test",
            from: "fixture-node-check",
            to: "fixture-node-terminal",
            priority: 10,
            condition: {
              fact: "criterion_state",
              criterionId: "fixture-criterion-acknowledge",
              op: "eq",
              value: "satisfied",
            },
          },
          {
            id: "fixture-edge-check-fallback",
            version: "1.0.0-test",
            from: "fixture-node-check",
            to: "fixture-node-terminal",
            priority: 99,
            fallback: true,
          },
        ],
      },
    ],
    scriptBeatCoverage: {
      expectedBeatCount: 4,
      expectedBundleCount: 3,
      expectedBeatIds: [
        "fixture-beat-1",
        "fixture-beat-2",
        "fixture-beat-3",
        "fixture-beat-4",
      ],
      bundles: [
        {
          id: "fixture-bundle-1",
          version: "1.0.0-test",
          beatIds: ["fixture-beat-1", "fixture-beat-2"],
        },
        {
          id: "fixture-bundle-2",
          version: "1.0.0-test",
          beatIds: ["fixture-beat-3"],
        },
        {
          id: "fixture-bundle-3",
          version: "1.0.0-test",
          beatIds: ["fixture-beat-4"],
        },
      ],
    },
  };
}

module.exports = {
  buildValidTrainingContentFixture,
};