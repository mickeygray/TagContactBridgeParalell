"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const publishedTrainingContent = require("../../packages/shared-services/src/trainer-content/publishedTrainingContent.v1");
const {
  PublishedTrainingContentValidationError,
  collectPublishedTrainingContentIssues,
  validatePublishedTrainingContent,
} = require("../../packages/shared-services/src/trainer-content/validatePublishedTrainingContent");
const {
  buildValidTrainingContentFixture,
} = require("../fixtures/trainer/trainingContentRegistry.fixture");

function cloneFixture() {
  return structuredClone(buildValidTrainingContentFixture());
}

function issueCodes(content, options = { allowTestContent: true }) {
  return collectPublishedTrainingContentIssues(content, options).map((issue) => issue.code);
}

test("production Trainer registry publishes the approved call-arc course", () => {
  assert.equal(publishedTrainingContent.status, "published");
  assert.equal(publishedTrainingContent.testOnly, false);
  assert.equal(publishedTrainingContent.ruleRegistry.status, "published");
  assert.ok(publishedTrainingContent.ruleRegistry.rules.length > 0);
  assert.equal(publishedTrainingContent.courseManifest.status, "published");
  assert.ok(publishedTrainingContent.courseManifest.items.length > 0);
  assert.deepEqual(publishedTrainingContent.courseManifest.overlays, []);
  assert.equal(
    publishedTrainingContent.scenarioBlueprints.length,
    publishedTrainingContent.courseManifest.items.length,
  );
  assert.equal(validatePublishedTrainingContent(publishedTrainingContent), true);
});

test("synthetic versioned content passes only with explicit test-content authority", () => {
  const fixture = cloneFixture();
  assert.equal(validatePublishedTrainingContent(fixture, { allowTestContent: true }), true);

  assert.throws(
    () => validatePublishedTrainingContent(fixture),
    (error) => {
      assert.ok(error instanceof PublishedTrainingContentValidationError);
      assert.ok(error.issues.some((issue) => issue.code === "test-content.disabled"));
      assert.ok(error.issues.some((issue) => issue.code === "authority.test-only"));
      return true;
    },
  );
});

test("validator rejects globally duplicate IDs and missing versions", () => {
  const fixture = cloneFixture();
  fixture.courseManifest.items[1].id = "fixture-rule-alpha";
  delete fixture.scenarioBlueprints[0].nodes[0].version;

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("id.duplicate"));
  assert.ok(codes.includes("version.missing"));
});

test("validator requires supported authority and non-empty citations", () => {
  const fixture = cloneFixture();
  fixture.ruleRegistry.rules[0].authority = {
    type: "internet-opinion",
    citations: [],
  };

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("authority.type.invalid"));
  assert.ok(codes.includes("authority.citations.missing"));
});

test("validator rejects invalid overlay scope, item targets, and rule references", () => {
  const fixture = cloneFixture();
  const overlay = fixture.courseManifest.overlays[0];
  overlay.scope = { region: "somewhere", direction: "sideways" };
  overlay.itemOverrides[0] = {
    itemId: "missing-item",
    ruleIds: ["missing-rule"],
  };

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("overlay.scope.key.invalid"));
  assert.ok(codes.includes("overlay.scope.direction.invalid"));
  assert.ok(codes.includes("overlay.item.missing"));
  assert.ok(codes.includes("reference.rule.missing"));
});

test("validator rejects missing item/rule references and cyclic prerequisites", () => {
  const fixture = cloneFixture();
  fixture.courseManifest.items[0].prerequisiteItemIds = ["fixture-item-practice"];
  fixture.courseManifest.items[1].prerequisiteItemIds = ["fixture-item-learn", "missing-item"];
  fixture.courseManifest.items[1].ruleIds.push("missing-rule");

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("reference.rule.missing"));
  assert.ok(codes.includes("reference.prerequisite.missing"));
  assert.ok(codes.includes("prerequisite.cycle"));
});

test("required deterministic grading rejects draft and advisory rules", () => {
  const fixture = cloneFixture();
  fixture.ruleRegistry.rules[0].status = "draft";
  fixture.ruleRegistry.rules[1].authority.type = "model-consideration";
  fixture.courseManifest.items[1].grading.ruleIds = [
    "fixture-rule-alpha",
    "fixture-rule-beta",
  ];

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("deterministic.rule.unpublished"));
  assert.ok(codes.includes("deterministic.authority.invalid"));
});

test("validator rejects invalid scenario starts, edges, dead ends, and unreachable nodes", () => {
  const fixture = cloneFixture();
  const scenario = fixture.scenarioBlueprints[0];
  scenario.startNodeId = "missing-node";
  scenario.edges[0].to = "missing-node";
  scenario.edges = scenario.edges.filter((edge) => edge.from !== "fixture-node-check");

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("scenario.start.missing"));
  assert.ok(codes.includes("scenario.edge.to.invalid"));
  assert.ok(codes.includes("scenario.node.dead-end"));
});

test("declared beat mapping rejects duplicate, uncovered, unknown, and count mismatch", () => {
  const fixture = cloneFixture();
  fixture.scriptBeatCoverage.expectedBundleCount = 28;
  fixture.scriptBeatCoverage.bundles[0].beatIds.push("fixture-beat-3");
  fixture.scriptBeatCoverage.bundles[1].beatIds = ["fixture-beat-unknown"];
  fixture.scriptBeatCoverage.bundles[2].beatIds = ["fixture-beat-2"];

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("coverage.bundle-count.mismatch"));
  assert.ok(codes.includes("coverage.bundle.beat.unknown"));
  assert.ok(codes.includes("coverage.beat.uncovered"));
  assert.ok(codes.includes("coverage.beat.multiple"));
});

test("Targeted Talk blueprints reject section escape, legacy transitions, and prohibited speech acts", () => {
  const fixture = cloneFixture();
  const scenario = fixture.scenarioBlueprints[0];
  scenario.nodes[1].sectionId = "fixture-section-price";
  scenario.nodes[0].allowedSpeechActs.push("quote-price");
  scenario.edges[0].when = "controller-decides";
  scenario.edges[0].condition = {
    fact: "model_score",
    op: "eq",
    value: "pass",
  };

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("gauntlet.node.section-boundary"));
  assert.ok(codes.includes("gauntlet.node.speech-acts.prohibited"));
  assert.ok(codes.includes("gauntlet.transition.legacy-when"));
  assert.ok(codes.includes("gauntlet.transition.condition.unsupported"));
});

test("Targeted Talk blueprints require bounded retries, parity, and complete audio policy", () => {
  const fixture = cloneFixture();
  const scenario = fixture.scenarioBlueprints[0];
  delete scenario.maxVisitsPerNode;
  scenario.variants[1].ruleIds = ["fixture-rule-alpha"];
  scenario.deliveryMode = "voice-required";
  scenario.audioManifest.requiredTargetIds = ["fixture-audio-opening"];

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("gauntlet.max-visits.invalid"));
  assert.ok(codes.includes("gauntlet.variant.gate-mutation"));
  assert.ok(codes.includes("gauntlet.variant.audio-parity"));
});

test("Targeted Talk blueprints require one fallback per non-terminal node", () => {
  const fixture = cloneFixture();
  const scenario = fixture.scenarioBlueprints[0];
  scenario.edges = scenario.edges.filter((edge) => edge.id !== "fixture-edge-start-fallback");

  const codes = issueCodes(fixture);
  assert.ok(codes.includes("gauntlet.transition.fallback.missing"));
});
