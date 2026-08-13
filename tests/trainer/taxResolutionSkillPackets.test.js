"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TAX_GROUP_SECTIONS } = require("../../packages/shared-services/src/taxGroupScript");
const {
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
  TAX_RESOLUTION_TOPIC_PACKETS,
  TAX_RESOLUTION_RULINGS,
} = require("../../packages/shared-services/src/trainer-content/taxResolutionSkillPackets.v1");

test("draft skill packets cover every approved script section and beat exactly once", () => {
  assert.deepEqual(
    TAX_RESOLUTION_SKILL_PACKETS.map((packet) => packet.sectionId),
    TAX_GROUP_SECTIONS.map((section) => section.id),
  );
  for (const section of TAX_GROUP_SECTIONS) {
    const packet = TAX_RESOLUTION_SKILL_PACKETS.find((entry) => entry.sectionId === section.id);
    assert.ok(packet, section.id);
    // Beat criteria come first; ruling-created criteria are appended after the
    // coverage assertion, so compare the leading slice. Script coverage still
    // has to be exact — a ruling may ADD, never quietly drop a beat.
    const beatCriteria = packet.criteria.filter(
      (criterion) => criterion.authority.type === "approved-script",
    );
    assert.deepEqual(
      beatCriteria.map((criterion) => criterion.authority.beatId),
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
    assert.ok(packet.retryPolicy.runRetryLimit >= 20, `${packet.id}: repeatable practice`);
    assert.equal(packet.retryPolicy.variantStrategy, "unused-first");
    for (const persona of packet.personas) {
      assert.equal(persona.gatePolicy, "identical-required-criteria");
      assert.equal(persona.protectedTraitPolicy, "no-gate-effect");
    }
    for (const criterion of packet.criteria) {
      // Every criterion gates UNLESS a recorded Mickey ruling demoted it — and a
      // demotion must name the ruling, so it can never be a silent softening.
      if (criterion.required === false) {
        assert.ok(criterion.rulingRef, `${criterion.criterionId} is optional with no rulingRef`);
        assert.ok(TAX_RESOLUTION_RULINGS[criterion.rulingRef], `unknown ruling ${criterion.rulingRef}`);
      } else {
        assert.equal(criterion.required, true);
      }
      assert.equal(criterion.ruleRevision, RULE_REVISION);
      if (criterion.authority.type === "approved-script") {
        assert.equal(criterion.authority.source, "packages/shared-services/src/taxGroupScript.js");
      } else {
        assert.equal(criterion.authority.type, "mickey-ruling");
        assert.ok(TAX_RESOLUTION_RULINGS[criterion.authority.rulingId]);
      }
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

test("Introduction is four practices — identity teaching was removed by ruling", () => {
  // ruling.company-disclosure-is-earned deleted intro.identify-the-firm: naming the
  // firm is no longer a taught opening move anywhere.
  const introduction = TAX_RESOLUTION_SKILL_PACKETS.find((packet) => packet.sectionId === "1");
  assert.equal(introduction.practiceModules.length, 4);
  assert.deepEqual(
    introduction.practiceModules.map((module) => module.moduleId),
    [
      "intro.start-the-call",
      "intro.explain-the-purpose",
      "intro.deflect-anger",
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
test("approved call-arc packets are explicitly compiled without mutating their draft records", () => {
  const production = require("../../packages/shared-services/src/trainer-content/publishedTrainingContent.v1");
  const expectedModules = TAX_RESOLUTION_SKILL_PACKETS.reduce(
    (total, packet) => total + packet.practiceModules.length,
    0,
  );
  assert.equal(production.status, "published");
  assert.equal(production.courseManifest.items.length, expectedModules);
  assert.equal(production.scenarioBlueprints.length, expectedModules);
  assert.ok(TAX_RESOLUTION_SKILL_PACKETS.every((packet) => packet.status === "draft"));
  assert.ok(production.courseManifest.items.every((item) => item.status === "published"));
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

test("recorded rulings are complete and citable", () => {
  // A ruling is Tier 1 authority (guide §3) and outranks the script. It must say
  // what it overrides and why, or a later session cannot tell a decision from a drift.
  for (const [id, ruling] of Object.entries(TAX_RESOLUTION_RULINGS)) {
    assert.equal(ruling.rulingId, id);
    assert.match(ruling.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(ruling.statement.length > 40, `${id}: statement`);
    assert.ok(ruling.overrides.length >= 1, `${id}: must name what it overrides`);
    assert.ok(ruling.reasoning.length > 40, `${id}: reasoning`);
  }
});

test("company specifics are taught in exactly one module, and it is in Representation", () => {
  // Mickey 2026-07-29: "nothing about identifying and providing information about
  // who we really are except in one section."
  const all = [...TAX_RESOLUTION_SKILL_PACKETS, ...TAX_RESOLUTION_TOPIC_PACKETS];
  const disclosureModules = all.flatMap((packet) =>
    (packet.practiceModules || [])
      .filter((module) => module.criterionIds.includes("tax-resolution.4.earned_disclosure"))
      .map((module) => ({ sectionId: packet.sectionId, moduleId: module.moduleId })));
  assert.equal(disclosureModules.length, 1, JSON.stringify(disclosureModules));
  assert.equal(disclosureModules[0].sectionId, "4");
  assert.equal(disclosureModules[0].moduleId, "representation.earned-disclosure");

  // Its criterion exists only because of the ruling, and says so.
  const rep = TAX_RESOLUTION_SKILL_PACKETS.find((packet) => packet.sectionId === "4");
  const criterion = rep.criteria.find((c) => c.criterionId === "tax-resolution.4.earned_disclosure");
  assert.ok(criterion);
  assert.equal(criterion.authority.type, "mickey-ruling");
  assert.equal(criterion.rulingRef, "ruling.company-disclosure-is-earned");
  // Both gates, not either — the whole point of the judgment.
  assert.match(criterion.description, /buyer intent AND substantial self-disclosure/i);
});

test("no module TEACHES naming the firm or pitching public records", () => {
  // Scoped to taught text. The phrases may appear in evidenceGuidance as things to
  // REJECT — that is the rulings being enforced, not violated.
  const all = [...TAX_RESOLUTION_SKILL_PACKETS, ...TAX_RESOLUTION_TOPIC_PACKETS];
  const banned = /public tax records|identify the firm|identify yourself/i;
  for (const packet of all) {
    for (const module of packet.practiceModules || []) {
      for (const field of ["title", "objective", "reading", "coachNudge", "listenFor"]) {
        assert.doesNotMatch(
          String(module[field]),
          banned,
          `${module.moduleId}.${field} still teaches a move the rulings removed`,
        );
      }
    }
    for (const signal of packet.teaching.responseSignals || []) {
      assert.doesNotMatch(String(signal.suggestedMove), banned, `signal "${signal.prospectPattern}"`);
    }
  }
});

test("objection handling is the most specific section", () => {
  // Mickey 2026-07-29: objections "should be the most specific scenarios with as many
  // different ones as you can think about — the spouse, the money, hired another company."
  const objections = TAX_RESOLUTION_TOPIC_PACKETS.find((packet) => packet.sectionId === "8");
  assert.ok(objections.practiceModules.length >= 12,
    `only ${objections.practiceModules.length} objection modules`);
  const ids = objections.practiceModules.map((module) => module.moduleId);
  for (const named of [
    "objections.spouse",
    "objections.cant-afford",
    "objections.incumbent",
    "objections.guarantee",
  ]) {
    assert.ok(ids.includes(named), `missing ${named}`);
  }
  // Specific means specific: several situations per scenario, not one token example.
  for (const module of objections.practiceModules) {
    assert.ok(module.situations.length >= 4,
      `${module.moduleId} has only ${module.situations.length} situations`);
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate objection moduleIds");
});
