"use strict";

const crypto = require("node:crypto");

function dialogueError(code) {
  const error = new Error(code);
  error.status = 503;
  error.code = code;
  return error;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildTargetedTalkSkillHeader({ scenario, state }) {
  const variant = (scenario?.variants || []).find((entry) =>
    entry.variantId === state?.variantId &&
    (!state.variantVersion || entry.version === state.variantVersion));
  if (!scenario?.id || !scenario?.version || !variant) {
    throw dialogueError("TRAINER_PROSPECT_SKILL_HEADER_INVALID");
  }
  const successCriteria = (scenario.nodes || [])
    .flatMap((node) => node.requiredCriteria || [])
    .map(({ criterionId, ruleId, ruleRevision, required }) => ({
      criterionId,
      ruleId,
      ruleRevision,
      required: required !== false,
    }));
  const header = Object.freeze({
    schemaVersion: "1",
    experienceMode: "gauntlet",
    blueprintId: scenario.id,
    blueprintVersion: scenario.version,
    sectionId: scenario.sectionId,
    direction: scenario.direction,
    localObjective: scenario.localObjective,
    maxTurns: scenario.maxTurns,
    ruleIds: Object.freeze([...(scenario.ruleIds || [])]),
    successCriteria: Object.freeze(successCriteria.map(Object.freeze)),
    prohibitedSpeechActs: Object.freeze([...(scenario.prohibitedSpeechActs || [])]),
    persona: Object.freeze({
      variantId: variant.variantId,
      variantVersion: variant.version,
      personaProfileId: variant.personaProfileId,
      factSetId: variant.factSetId,
      utteranceSetIds: Object.freeze([...(variant.utteranceSetIds || [])]),
      voiceProfileId: variant.voiceProfileId,
    }),
  });
  return Object.freeze({
    cacheKey: `targeted-talk-skill/${crypto.createHash("sha256")
      .update(stableStringify(header))
      .digest("hex")}`,
    header,
  });
}

function createTrainingProspectDialogueService({ generateDialogue }) {
  if (typeof generateDialogue !== "function") {
    throw new TypeError("prospect dialogue generator is required");
  }
  async function respond({ scenario, state, reactionIntent, learnerText }) {
    if (!scenario || state?.blueprintId !== scenario.id ||
        state?.sectionId !== scenario.sectionId) {
      throw dialogueError("TRAINER_PROSPECT_BOUNDARY_INVALID");
    }
    const node = (scenario.nodes || []).find((entry) => entry.id === state.currentNodeId);
    if (!node || node.sectionId !== scenario.sectionId || node.type === "terminal") {
      throw dialogueError("TRAINER_PROSPECT_BOUNDARY_INVALID");
    }
    const skillPacket = buildTargetedTalkSkillHeader({ scenario, state });
    const output = await generateDialogue({
      cachedSkillHeader: skillPacket.header,
      skillHeaderCacheKey: skillPacket.cacheKey,
      turnDirective: {
        currentNodeId: node.id,
        reactionIntent: reactionIntent || node.reactionIntent,
        allowedSpeechActs: node.allowedSpeechActs || [],
      },
      learnerUtterance: String(learnerText || ""),
    });
    const text = String(output?.text || "").trim();
    const speechActs = Array.isArray(output?.speechActs)
      ? [...new Set(output.speechActs.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const allowed = new Set(node.allowedSpeechActs || []);
    const prohibited = new Set(scenario.prohibitedSpeechActs || []);
    if (!text || speechActs.length === 0 ||
        speechActs.some((act) => prohibited.has(act) || !allowed.has(act))) {
      throw dialogueError("TRAINER_PROSPECT_DIALOGUE_REJECTED");
    }
    return Object.freeze({ text, speechActs: Object.freeze(speechActs) });
  }
  return Object.freeze({ respond });
}

module.exports = {
  buildTargetedTalkSkillHeader,
  createTrainingProspectDialogueService,
};
