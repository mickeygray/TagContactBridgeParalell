"use strict";

// Explicit production promotion approved by Mickey on 2026-08-13. The source
// packets remain immutable authoring records; this module compiles their
// approved call-arc material into the stricter published course contract.
// Field-manual topic packets remain out of this first production course until
// their authority type has its own publication contract.

const {
  TAX_RESOLUTION_SKILL_PACKETS,
} = require("./taxResolutionSkillPackets.v1");

const VERSION = "1.0.0";
const COURSE_ID = "tax-resolution-core-v1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function directionFor(packet, moduleDef) {
  if (["inbound", "outbound"].includes(moduleDef.direction)) {
    return moduleDef.direction;
  }
  return (packet.directions || []).find((value) =>
    value === "inbound" || value === "outbound") || "outbound";
}

function authorityFor(criterion) {
  if (criterion.authority?.type === "mickey-ruling") {
    return {
      type: "mickey-ruling",
      citations: [
        `packages/shared-services/src/trainer-content/taxResolutionSkillPackets.v1.js#${criterion.authority.rulingId}`,
      ],
    };
  }
  const source = criterion.authority?.source ||
    "packages/shared-services/src/taxGroupScript.js";
  const section = criterion.authority?.sectionId || "unknown-section";
  const beat = criterion.authority?.beatId || criterion.ruleId;
  return {
    type: "approved-tax-resolution-script",
    citations: [`${source}#${section}/${beat}@${criterion.ruleRevision}`],
  };
}

const ruleMap = new Map();
for (const packet of TAX_RESOLUTION_SKILL_PACKETS) {
  for (const criterion of packet.criteria || []) {
    if (ruleMap.has(criterion.ruleId)) continue;
    ruleMap.set(criterion.ruleId, {
      id: criterion.ruleId,
      version: criterion.ruleRevision,
      status: "published",
      revision: criterion.ruleRevision,
      statement: criterion.description,
      authority: authorityFor(criterion),
    });
  }
}

const items = [];
const scenarios = [];
let prerequisiteItemId = null;

for (const packet of TAX_RESOLUTION_SKILL_PACKETS) {
  for (const [moduleIndex, moduleDef] of (packet.practiceModules || []).entries()) {
    const itemId = `tax-resolution.practice.${slug(moduleDef.moduleId)}`;
    const blueprintId = `${itemId}.scenario`;
    const direction = directionFor(packet, moduleDef);
    const criteria = (packet.criteria || [])
      .filter((criterion) => (moduleDef.criterionIds || []).includes(criterion.criterionId))
      .filter((criterion) =>
        !criterion.appliesWhen?.direction ||
        criterion.appliesWhen.direction === direction)
      .map((criterion) => ({
        criterionId: criterion.criterionId,
        ruleId: criterion.ruleId,
        ruleRevision: criterion.ruleRevision,
        detector: "semantic",
        required: criterion.required !== false,
        description: criterion.description,
        evidenceGuidance: criterion.evidenceGuidance,
      }));
    const ruleIds = [...new Set(criteria.map((criterion) => criterion.ruleId))];
    const maxTurns = Math.max(2, Math.min(5, Number(packet.maxTurns) || 4));
    const nodeIds = Array.from(
      { length: maxTurns },
      (_unused, index) => `${blueprintId}.turn-${index + 1}`,
    );
    const terminalId = `${blueprintId}.terminal`;
    const requiredCriteria = criteria.filter((criterion) => criterion.required);
    const passCondition = requiredCriteria.length === 0
      ? { fact: "turn_count", op: "gte", value: 1 }
      : requiredCriteria.length === 1
        ? {
            fact: "criterion_state",
            criterionId: requiredCriteria[0].criterionId,
            op: "eq",
            value: "satisfied",
          }
        : {
            all: requiredCriteria.map((criterion) => ({
              fact: "criterion_state",
              criterionId: criterion.criterionId,
              op: "eq",
              value: "satisfied",
            })),
          };
    const situations = moduleDef.situations?.length
      ? moduleDef.situations
      : packet.situations || [];
    const variants = (packet.personas || []).map((persona, personaIndex) => ({
      variantId: `${blueprintId}.${slug(persona.variantId)}`,
      version: VERSION,
      personaProfileId: `${blueprintId}.persona-${personaIndex + 1}`,
      factSetId: `${blueprintId}.facts-${personaIndex + 1}`,
      utteranceSetIds: [`${blueprintId}.utterances-${personaIndex + 1}`],
      voiceProfileId: "sales-trainer-default-voice",
      requiredAudioTargetIds: [],
      posture: persona.posture,
      behavior: persona.behavior,
      situation: situations[personaIndex % Math.max(1, situations.length)] ||
        moduleDef.objective,
    }));

    items.push({
      id: itemId,
      version: VERSION,
      status: "published",
      type: "gauntlet",
      required: true,
      ruleIds,
      prerequisiteItemIds: prerequisiteItemId ? [prerequisiteItemId] : [],
      blueprintId,
      blueprintVersion: VERSION,
      promptVersion: "targeted-talk-v1",
      presentation: {
        title: `${packet.sectionId}.${moduleIndex + 1} ${moduleDef.title}`,
        summary: moduleDef.objective,
        body: moduleDef.reading,
        instructions:
          "Listen to the prospect, respond naturally, and solve only this part of the call. The Coach will nudge without giving you the answer.",
        prompt: situations[0] || moduleDef.objective,
        estimatedMinutes: Math.max(3, Math.ceil(maxTurns / 2)),
        coachingGuide: {
          objective: moduleDef.objective,
          exactMoves: [],
          responseSignals: (packet.teaching?.responseSignals || []).map((signal) => ({
            signalId: signal.signalId || slug(signal.prospectPattern),
            prospectPattern: signal.prospectPattern,
            coachNotice: signal.coachNotice,
            suggestedMove: signal.suggestedMove,
            listenFor: signal.listenFor,
          })),
          practiceModules: [{
            moduleId: moduleDef.moduleId,
            title: moduleDef.title,
            objective: moduleDef.objective,
            reading: moduleDef.reading,
            questionCount: (moduleDef.questions || []).length,
          }],
        },
      },
    });

    const nodes = nodeIds.map((nodeId, nodeIndex) => ({
      id: nodeId,
      version: VERSION,
      type: "checkpoint",
      sectionId: packet.sectionId,
      reactionIntent: moduleDef.listenFor ||
        "Respond naturally while remaining inside this practice objective.",
      allowedSpeechActs: ["respond-to-learner"],
      // Criteria are declared exactly once per blueprint (the publication
      // contract requires globally unique criterion IDs). The controller and
      // evaluator carry this scenario-level checklist across later turns.
      requiredCriteria: nodeIndex === 0 ? criteria : [],
      ruleIds,
      gate: {
        required: true,
        deterministic: true,
        ruleIds: requiredCriteria.map((criterion) => criterion.ruleId),
      },
    }));
    nodes.push({
      id: terminalId,
      version: VERSION,
      type: "terminal",
      sectionId: packet.sectionId,
      reactionIntent: "",
      allowedSpeechActs: [],
      requiredCriteria: [],
      ruleIds: [],
    });

    const edges = [];
    for (const [nodeIndex, nodeId] of nodeIds.entries()) {
      edges.push({
        id: `${nodeId}.pass`,
        version: VERSION,
        from: nodeId,
        to: terminalId,
        priority: 10,
        condition: passCondition,
      });
      edges.push({
        id: `${nodeId}.fallback`,
        version: VERSION,
        from: nodeId,
        to: nodeIds[nodeIndex + 1] || terminalId,
        priority: 99,
        fallback: true,
      });
    }

    scenarios.push({
      id: blueprintId,
      version: VERSION,
      status: "published",
      experienceMode: "gauntlet",
      sectionId: packet.sectionId,
      direction,
      localObjective: moduleDef.objective,
      deliveryMode: "voice-dynamic",
      maxTurns,
      maxVisitsPerNode: 1,
      startNodeId: nodeIds[0],
      ruleIds,
      prohibitedSpeechActs: [...(packet.prohibitedMoves || [])],
      retryPolicy: {
        nodeRetryLimit: maxTurns - 1,
        runRetryLimit: Math.min(2, Math.max(0, variants.length - 1)),
        variantStrategy: "unused-first",
      },
      hintPolicy: { steps: [] },
      audioManifest: {
        id: `${blueprintId}.dynamic-audio`,
        version: VERSION,
        requiredTargetIds: [],
      },
      variants,
      nodes,
      edges,
      presentation: {
        sectionTitle: packet.title,
        moduleId: moduleDef.moduleId,
        title: moduleDef.title,
        objective: moduleDef.objective,
        reading: moduleDef.reading,
        coachNudge: moduleDef.coachNudge,
        listenFor: moduleDef.listenFor,
        openingLine: situations[0] || moduleDef.objective,
        questions: moduleDef.questions || [],
      },
    });
    prerequisiteItemId = itemId;
  }
}

const ruleRegistry = {
  id: "tax-resolution-rule-registry",
  version: VERSION,
  status: "published",
  testOnly: false,
  rules: [...ruleMap.values()],
};

const courseManifest = {
  id: COURSE_ID,
  version: VERSION,
  status: "published",
  title: "Tax Resolution Sales Training",
  aliases: ["tax-resolution", "tax-resolution-core"],
  allowedCompanies: ["TAG", "WYNN", "AMITY"],
  enrollmentDefault: true,
  items,
  overlays: [],
};

module.exports = deepFreeze({
  ruleRegistry,
  courseManifest,
  scenarioBlueprints: scenarios,
});
