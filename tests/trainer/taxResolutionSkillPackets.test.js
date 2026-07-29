"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TAX_GROUP_SECTIONS } = require("../../packages/shared-services/src/taxGroupScript");
const {
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
} = require("../../packages/shared-services/src/trainer-content/taxResolutionSkillPackets.v1");

test("draft skill packets cover every approved script section and beat exactly once", () => {
  assert.deepEqual(
    TAX_RESOLUTION_SKILL_PACKETS.map((packet) => packet.sectionId),
    TAX_GROUP_SECTIONS.map((section) => section.id),
  );
  for (const section of TAX_GROUP_SECTIONS) {
    const packet = TAX_RESOLUTION_SKILL_PACKETS.find((entry) => entry.sectionId === section.id);
    assert.ok(packet, section.id);
    assert.deepEqual(
      packet.criteria.map((criterion) => criterion.authority.beatId),
      section.beats.map((beat) => beat.id),
    );
  }
});

test("every packet is a bounded draft with persona parity and cited grading authority", () => {
  for (const packet of TAX_RESOLUTION_SKILL_PACKETS) {
    assert.equal(packet.status, "draft");
    assert.equal(packet.experienceMode, "gauntlet");
    assert.equal(packet.certificationEligible, false);
    assert.ok(packet.maxTurns > 0);
    assert.ok(packet.personas.length >= 3);
    assert.ok(packet.situations.length >= 3);
    assert.ok(packet.prohibitedMoves.length >= 3);
    assert.ok(packet.reflectionPrompt);
    assert.ok(packet.questions.length >= 2);
    for (const persona of packet.personas) {
      assert.equal(persona.gatePolicy, "identical-required-criteria");
      assert.equal(persona.protectedTraitPolicy, "no-gate-effect");
    }
    for (const criterion of packet.criteria) {
      assert.equal(criterion.required, true);
      assert.equal(criterion.ruleRevision, RULE_REVISION);
      assert.equal(criterion.authority.source, "packages/shared-services/src/taxGroupScript.js");
      assert.ok(criterion.evidenceGuidance);
    }
  }
});

test("section packets preserve their unique skill boundaries", () => {
  const bySection = new Map(TAX_RESOLUTION_SKILL_PACKETS.map((packet) => [packet.sectionId, packet]));
  assert.match(bySection.get("2").localObjective, /case picture/i);
  assert.ok(bySection.get("2").prohibitedMoves.some((move) => /quoting a fee/i.test(move)));
  assert.match(bySection.get("4B").localObjective, /payment ladder/i);
  assert.ok(bySection.get("4B").prohibitedMoves.some((move) => /before anchoring full payment/i.test(move)));
  assert.match(bySection.get("6").localObjective, /think-it-over/i);
  assert.match(bySection.get("7").localObjective, /next steps/i);
  assert.deepEqual(
    bySection.get("1").criteria.find((criterion) => criterion.authority.beatId === "inbound_greeting").appliesWhen,
    { direction: "inbound" },
  );
  assert.deepEqual(
    bySection.get("1").criteria.find((criterion) => criterion.authority.beatId === "outbound_opener").appliesWhen,
    { direction: "outbound" },
  );
});

test("draft packets are not silently imported into the production registry", () => {
  const production = require("../../packages/shared-services/src/trainer-content/publishedTrainingContent.v1");
  assert.equal(production.courseManifest.items.length, 0);
  assert.equal(production.scenarioBlueprints.length, 0);
});
