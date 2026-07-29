"use strict";

function dialogueError(code) {
  const error = new Error(code);
  error.status = 503;
  error.code = code;
  return error;
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
    const output = await generateDialogue({
      immutableContext: {
        experienceMode: "gauntlet",
        sectionId: scenario.sectionId,
        reactionIntent: reactionIntent || node.reactionIntent,
        allowedSpeechActs: node.allowedSpeechActs || [],
        prohibitedSpeechActs: scenario.prohibitedSpeechActs || [],
        variantId: state.variantId,
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

module.exports = { createTrainingProspectDialogueService };
