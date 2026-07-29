"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TAX_GROUP_SECTIONS } = require("../../packages/shared-services/src/taxGroupScript");
const {
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
  TAX_RESOLUTION_TOPIC_PACKETS,
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

test("Introduction is split into five read-talk-reflect practices", () => {
  const introduction = TAX_RESOLUTION_SKILL_PACKETS.find((packet) => packet.sectionId === "1");
  assert.equal(introduction.practiceModules.length, 5);
  assert.deepEqual(
    introduction.practiceModules.map((module) => module.moduleId),
    [
      "intro.start-the-call",
      "intro.deflect-anger",
      "intro.identify-the-firm",
      "intro.explain-the-purpose",
      "intro.earn-the-story",
    ],
  );
  for (const module of introduction.practiceModules) {
    assert.ok(module.reading);
    assert.ok(module.objective);
    assert.ok(module.situations.length >= 2);
    assert.ok(module.questions.length >= 1);
    assert.ok(module.questions[0].gradingPoints.length >= 3);
  }
});

test("draft packets are not silently imported into the production registry", () => {
  const production = require("../../packages/shared-services/src/trainer-content/publishedTrainingContent.v1");
  assert.equal(production.courseManifest.items.length, 0);
  assert.equal(production.scenarioBlueprints.length, 0);
});


test("every call-arc packet is split into read-talk-answer practice modules", () => {
  // Mickey 2026-07-29: "each of those is broken into 4 or more chunks... you
  // provide them with targeted reading... then you invoke the entire coach
  // loop... then a short question and answer section." Introduction keeps its
  // own stricter test; this pins the rhythm for the rest of the arc.
  for (const packet of TAX_RESOLUTION_SKILL_PACKETS) {
    const modules = packet.practiceModules || [];
    assert.ok(modules.length >= 3, `${packet.id} has ${modules.length} modules — the vision is 3+ per section`);
    const seen = new Set();
    const criterionIds = new Set(packet.criteria.map((c) => c.criterionId));
    const exercised = new Set();
    for (const moduleDef of modules) {
      assert.ok(moduleDef.moduleId && !seen.has(moduleDef.moduleId), `${packet.id}: duplicate/missing moduleId`);
      seen.add(moduleDef.moduleId);
      assert.ok(moduleDef.reading, `${moduleDef.moduleId}: reading is the READ leg`);
      assert.ok(moduleDef.objective, `${moduleDef.moduleId}: objective`);
      assert.ok(moduleDef.coachNudge, `${moduleDef.moduleId}: coachNudge`);
      assert.ok(moduleDef.listenFor, `${moduleDef.moduleId}: listenFor`);
      assert.ok((moduleDef.situations || []).length >= 2, `${moduleDef.moduleId}: TALK leg needs >=2 situations`);
      assert.ok((moduleDef.questions || []).length >= 1, `${moduleDef.moduleId}: ANSWER leg needs >=1 question`);
      for (const q of moduleDef.questions) {
        assert.ok((q.gradingPoints || []).length >= 3, `${q.questionId}: >=3 gradingPoints`);
      }
      for (const cid of moduleDef.criterionIds) {
        assert.ok(criterionIds.has(cid), `${moduleDef.moduleId} cites unknown criterion ${cid}`);
        exercised.add(cid);
      }
    }
    for (const cid of criterionIds) {
      assert.ok(exercised.has(cid), `${packet.id}: criterion ${cid} is exercised by no module`);
    }
  }
});

test("topic packets extract from the field manual under a distinct revision", () => {
  assert.equal(TAX_RESOLUTION_TOPIC_PACKETS.length, 3);
  assert.deepEqual(
    TAX_RESOLUTION_TOPIC_PACKETS.map((packet) => packet.id),
    ["tax-resolution.objections", "tax-resolution.tactics", "tax-resolution.tax"],
  );
  for (const packet of TAX_RESOLUTION_TOPIC_PACKETS) {
    assert.equal(packet.status, "draft");
    assert.equal(packet.certificationEligible, false);
    assert.equal(packet.authority.type, "field-manual-extract");
    assert.ok(packet.personas.length >= 3);
    assert.ok(packet.situations.length >= 3);
    assert.ok(packet.prohibitedMoves.length >= 3);
    assert.ok(packet.questions.length >= 2);
    assert.ok((packet.practiceModules || []).length >= 3, `${packet.id}: 3+ modules`);
    for (const persona of packet.personas) {
      assert.equal(persona.gatePolicy, "identical-required-criteria");
      assert.equal(persona.protectedTraitPolicy, "no-gate-effect");
    }
    const criterionIds = new Set(packet.criteria.map((c) => c.criterionId));
    for (const criterion of packet.criteria) {
      assert.equal(criterion.required, true);
      assert.equal(criterion.ruleRevision, "field-manual-extract-1");
      assert.equal(criterion.authority.type, "field-manual-extract");
      assert.ok(criterion.authority.entryIds.length >= 1, `${criterion.criterionId}: must cite manual entries`);
      assert.ok(criterion.evidenceGuidance);
    }
    for (const q of packet.questions) {
      for (const cid of q.rubricCriterionIds) {
        assert.ok(criterionIds.has(cid), `${q.questionId} cites unknown criterion ${cid}`);
      }
    }
  }
});

test("topic packet manual citations point at entries that exist", () => {
  // The manual is TypeScript under apps/web-client — not requireable here, so
  // verify citations textually: every cited entryId appears in the content dir.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "../../apps/web-client/src/workspaces/field-manual/content");
  const corpus = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  for (const packet of TAX_RESOLUTION_TOPIC_PACKETS) {
    for (const criterion of packet.criteria) {
      for (const entryId of criterion.authority.entryIds) {
        assert.ok(
          corpus.includes(`"${entryId}"`) || corpus.includes(`'${entryId}'`) || corpus.includes(`id: "${entryId}"`),
          `${criterion.criterionId} cites manual entry "${entryId}" which does not exist`,
        );
      }
    }
  }
});
