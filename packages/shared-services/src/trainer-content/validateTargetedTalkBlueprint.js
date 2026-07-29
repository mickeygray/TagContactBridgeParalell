"use strict";

const {
  DIRECTIONS,
  SCENARIO_DELIVERY_MODES,
  TRANSITION_FACTS,
  TRANSITION_OPERATORS,
} = require("./publishedTrainingContentContracts");

const CRITERION_DETECTORS = new Set(["exact", "sequence", "semantic"]);
const VARIANT_FORBIDDEN_KEYS = new Set([
  "sectionId",
  "ruleIds",
  "requiredCriteria",
  "retryPolicy",
  "terminalOutcomes",
]);

function sameStringSet(left, right) {
  const leftValues = Array.isArray(left) ? left : [];
  const rightValues = Array.isArray(right) ? right : [];
  if (leftValues.length !== rightValues.length) return false;
  return new Set(leftValues).size === new Set(rightValues).size
    && leftValues.every((value) => rightValues.includes(value));
}

function validateTargetedTalkBlueprint({
  scenario,
  scenarioPath,
  nodes,
  edges,
  nodeIds,
  terminalNodeIds,
  outgoing,
  rootIsTestOnly,
  allowTestContent,
  addIssue,
  hasText,
  isObject,
  list,
  requireIdentity,
  assertRuleRefs,
  rulesById,
}) {
  if (scenario?.experienceMode !== "gauntlet") return;

  const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  const sectionId = hasText(scenario.sectionId) ? scenario.sectionId.trim() : null;
  if (!sectionId) {
    addIssue("gauntlet.section.missing", `${scenarioPath}.sectionId`, "Targeted Talk must declare one canonical sectionId");
  }
  if (!hasText(scenario.localObjective)) {
    addIssue("gauntlet.objective.missing", `${scenarioPath}.localObjective`, "Targeted Talk must declare a local objective");
  }
  if (!DIRECTIONS.includes(scenario.direction)) {
    addIssue("gauntlet.direction.invalid", `${scenarioPath}.direction`, "Targeted Talk direction must be inbound or outbound");
  }
  if (!SCENARIO_DELIVERY_MODES.includes(scenario.deliveryMode)) {
    addIssue("gauntlet.delivery.invalid", `${scenarioPath}.deliveryMode`, "Targeted Talk must declare a supported delivery mode");
  }
  if (scenario.deliveryMode === "text-only-test" && !(rootIsTestOnly && allowTestContent)) {
    addIssue("gauntlet.delivery.test-only", `${scenarioPath}.deliveryMode`, "Text-only Targeted Talk delivery is limited to explicitly enabled test content");
  }
  if (!isPositiveInteger(scenario.maxTurns)) {
    addIssue("gauntlet.max-turns.invalid", `${scenarioPath}.maxTurns`, "Targeted Talk maxTurns must be a positive integer");
  }
  if (!isPositiveInteger(scenario.maxVisitsPerNode)) {
    addIssue("gauntlet.max-visits.invalid", `${scenarioPath}.maxVisitsPerNode`, "Targeted Talk maxVisitsPerNode must be a positive integer");
  }
  if (isPositiveInteger(scenario.maxTurns) && isPositiveInteger(scenario.maxVisitsPerNode) && scenario.maxVisitsPerNode > scenario.maxTurns) {
    addIssue("gauntlet.max-visits.exceeds-turns", `${scenarioPath}.maxVisitsPerNode`, "Targeted Talk maxVisitsPerNode cannot exceed maxTurns");
  }

  const retryPolicy = scenario.retryPolicy;
  if (!isObject(retryPolicy) || !isPositiveInteger(retryPolicy.nodeRetryLimit) || !Number.isSafeInteger(retryPolicy.runRetryLimit) || retryPolicy.runRetryLimit < 0 || retryPolicy.variantStrategy !== "unused-first") {
    addIssue("gauntlet.retry-policy.invalid", `${scenarioPath}.retryPolicy`, "Targeted Talk must declare bounded unused-first retry policy");
  }
  const hintPolicy = scenario.hintPolicy;
  if (!isObject(hintPolicy) || !Array.isArray(hintPolicy.steps)) {
    addIssue("gauntlet.hint-policy.invalid", `${scenarioPath}.hintPolicy`, "Targeted Talk must declare a hint policy with steps");
  }

  const prohibitedSpeechActs = list(scenario.prohibitedSpeechActs);
  if (!Array.isArray(scenario.prohibitedSpeechActs) || prohibitedSpeechActs.some((speechAct) => !hasText(speechAct))) {
    addIssue("gauntlet.prohibited-speech.invalid", `${scenarioPath}.prohibitedSpeechActs`, "Targeted Talk prohibitedSpeechActs must be an array of non-empty strings");
  }

  const audioManifest = scenario.audioManifest;
  const audioTargetIds = list(audioManifest?.requiredTargetIds);
  if (!isObject(audioManifest) || !hasText(audioManifest.id) || !hasText(audioManifest.version) || !Array.isArray(audioManifest.requiredTargetIds)) {
    addIssue("gauntlet.audio-manifest.invalid", `${scenarioPath}.audioManifest`, "Targeted Talk must declare a versioned audio manifest");
  }
  if (scenario.deliveryMode === "voice-required" && audioTargetIds.length === 0) {
    addIssue("gauntlet.audio-manifest.missing-targets", `${scenarioPath}.audioManifest.requiredTargetIds`, "Voice-required Targeted Talk must declare required audio targets");
  }
  if (scenario.deliveryMode === "text-only-test" && audioTargetIds.length > 0) {
    addIssue("gauntlet.audio-manifest.text-targets", `${scenarioPath}.audioManifest.requiredTargetIds`, "Text-only Targeted Talk cannot require audio targets");
  }

  const variants = list(scenario.variants);
  if (!Array.isArray(scenario.variants) || variants.length === 0) {
    addIssue("gauntlet.variants.missing", `${scenarioPath}.variants`, "Targeted Talk must declare at least one variant");
  }
  const variantIds = new Set();
  variants.forEach((variant, variantIndex) => {
    const variantPath = `${scenarioPath}.variants[${variantIndex}]`;
    if (!isObject(variant)) {
      addIssue("gauntlet.variant.invalid", variantPath, "Targeted Talk variant must be an object");
      return;
    }
    const variantId = hasText(variant.variantId) ? variant.variantId.trim() : null;
    if (!variantId || variantIds.has(variantId)) {
      addIssue("gauntlet.variant.id.invalid", `${variantPath}.variantId`, "Targeted Talk variantId must be unique and non-empty");
    } else {
      variantIds.add(variantId);
    }
    ["version", "personaProfileId", "factSetId", "voiceProfileId"].forEach((key) => {
      if (!hasText(variant[key])) {
        addIssue("gauntlet.variant.field.missing", `${variantPath}.${key}`, `Targeted Talk variant must declare ${key}`);
      }
    });
    if (!Array.isArray(variant.utteranceSetIds) || variant.utteranceSetIds.length === 0 || variant.utteranceSetIds.some((value) => !hasText(value))) {
      addIssue("gauntlet.variant.utterances.invalid", `${variantPath}.utteranceSetIds`, "Targeted Talk variant must declare utteranceSetIds");
    }
    if (!Array.isArray(variant.requiredAudioTargetIds) || variant.requiredAudioTargetIds.some((value) => !hasText(value))) {
      addIssue("gauntlet.variant.audio.invalid", `${variantPath}.requiredAudioTargetIds`, "Targeted Talk variant must declare requiredAudioTargetIds");
    } else if (!sameStringSet(variant.requiredAudioTargetIds, audioTargetIds)) {
      addIssue("gauntlet.variant.audio-parity", `${variantPath}.requiredAudioTargetIds`, "Targeted Talk variant audio targets must match the pinned audio manifest");
    }
    VARIANT_FORBIDDEN_KEYS.forEach((key) => {
      if (Object.hasOwn(variant, key)) {
        addIssue("gauntlet.variant.gate-mutation", `${variantPath}.${key}`, `Targeted Talk variant cannot change ${key}`);
      }
    });
  });

  const validateCondition = (condition, conditionPath) => {
    if (!isObject(condition)) {
      addIssue("gauntlet.transition.condition.invalid", conditionPath, "Targeted Talk transition condition must be an object");
      return;
    }
    if (Array.isArray(condition.all) || Array.isArray(condition.any)) {
      const key = Array.isArray(condition.all) ? "all" : "any";
      const values = condition[key];
      if (values.length === 0 || values.some((value) => !isObject(value))) {
        addIssue("gauntlet.transition.condition.invalid", conditionPath, "Targeted Talk transition group must contain conditions");
        return;
      }
      values.forEach((value, index) => validateCondition(value, `${conditionPath}.${key}[${index}]`));
      return;
    }
    if (isObject(condition.not)) {
      validateCondition(condition.not, `${conditionPath}.not`);
      return;
    }
    if (!TRANSITION_FACTS.includes(condition.fact) || !TRANSITION_OPERATORS.includes(condition.op)) {
      addIssue("gauntlet.transition.condition.unsupported", conditionPath, "Targeted Talk transition uses an unsupported fact or operator");
      return;
    }
    if (!Object.hasOwn(condition, "value")) {
      addIssue("gauntlet.transition.condition.value-missing", `${conditionPath}.value`, "Targeted Talk transition condition must declare a value");
    }
    if (condition.fact === "criterion_state" && !hasText(condition.criterionId)) {
      addIssue("gauntlet.transition.condition.criterion-missing", `${conditionPath}.criterionId`, "criterion_state transition condition must identify a criterion");
    }
  };

  const criterionIds = new Set();
  nodes.forEach((node, nodeIndex) => {
    if (!isObject(node)) return;
    const nodePath = `${scenarioPath}.nodes[${nodeIndex}]`;
    if (node.sectionId !== sectionId) {
      addIssue("gauntlet.node.section-boundary", `${nodePath}.sectionId`, "Targeted Talk node must remain in the pinned section");
    }
    if (node.type !== "terminal" && !hasText(node.reactionIntent)) {
      addIssue("gauntlet.node.reaction.missing", `${nodePath}.reactionIntent`, "Non-terminal Targeted Talk node must declare a reaction intent");
    }
    if (!Array.isArray(node.allowedSpeechActs) || node.allowedSpeechActs.some((speechAct) => !hasText(speechAct))) {
      addIssue("gauntlet.node.speech-acts.invalid", `${nodePath}.allowedSpeechActs`, "Targeted Talk node must declare allowed speech acts");
    } else if (node.allowedSpeechActs.some((speechAct) => prohibitedSpeechActs.includes(speechAct))) {
      addIssue("gauntlet.node.speech-acts.prohibited", `${nodePath}.allowedSpeechActs`, "Targeted Talk node cannot allow a prohibited speech act");
    }
    const criteria = list(node.requiredCriteria);
    if (!Array.isArray(node.requiredCriteria)) {
      addIssue("gauntlet.node.criteria.invalid", `${nodePath}.requiredCriteria`, "Targeted Talk node must declare requiredCriteria");
      return;
    }
    criteria.forEach((criterion, criterionIndex) => {
      const criterionPath = `${nodePath}.requiredCriteria[${criterionIndex}]`;
      if (!isObject(criterion) || !hasText(criterion.criterionId) || !hasText(criterion.ruleId) || !hasText(criterion.ruleRevision) || !CRITERION_DETECTORS.has(criterion.detector) || typeof criterion.required !== "boolean") {
        addIssue("gauntlet.node.criterion.invalid", criterionPath, "Targeted Talk criterion must be complete and typed");
        return;
      }
      if (criterionIds.has(criterion.criterionId)) {
        addIssue("gauntlet.node.criterion.duplicate", `${criterionPath}.criterionId`, "Targeted Talk criterionId must be globally unique within a blueprint");
      } else {
        criterionIds.add(criterion.criterionId);
      }
      assertRuleRefs([criterion.ruleId], `${criterionPath}.ruleId`, `Targeted Talk criterion "${criterion.criterionId}"`);
      const rule = rulesById.get(criterion.ruleId);
      if (rule && rule.version !== criterion.ruleRevision) {
        addIssue("gauntlet.node.criterion.revision", `${criterionPath}.ruleRevision`, "Targeted Talk criterion must pin the current rule revision");
      }
    });
  });

  const edgesByFrom = new Map();
  edges.forEach((edge, edgeIndex) => {
    if (!isObject(edge)) return;
    const edgePath = `${scenarioPath}.edges[${edgeIndex}]`;
    if (Object.hasOwn(edge, "when")) {
      addIssue("gauntlet.transition.legacy-when", `${edgePath}.when`, "Targeted Talk transition cannot use a string when expression");
    }
    if (!Number.isSafeInteger(edge.priority) || edge.priority < 0) {
      addIssue("gauntlet.transition.priority.invalid", `${edgePath}.priority`, "Targeted Talk transition priority must be a non-negative integer");
    }
    if (edge.fallback === true) {
      if (Object.hasOwn(edge, "condition")) {
        addIssue("gauntlet.transition.fallback.condition", `${edgePath}.condition`, "Targeted Talk fallback cannot have a condition");
      }
    } else {
      validateCondition(edge.condition, `${edgePath}.condition`);
    }
    if (nodeIds.has(edge.from)) {
      const entries = edgesByFrom.get(edge.from) || [];
      entries.push(edge);
      edgesByFrom.set(edge.from, entries);
    }
  });

  nodes.forEach((node, nodeIndex) => {
    if (!isObject(node) || node.type === "terminal" || !nodeIds.has(node.id)) return;
    const nodeEdges = edgesByFrom.get(node.id) || [];
    const fallbackCount = nodeEdges.filter((edge) => edge.fallback === true).length;
    const priorities = new Set();
    nodeEdges.forEach((edge) => {
      if (Number.isSafeInteger(edge.priority)) {
        if (priorities.has(edge.priority)) {
          addIssue("gauntlet.transition.priority.duplicate", `${scenarioPath}.nodes[${nodeIndex}]`, "Targeted Talk transition priorities must be unique per node");
        }
        priorities.add(edge.priority);
      }
    });
    if (fallbackCount !== 1) {
      addIssue("gauntlet.transition.fallback.missing", `${scenarioPath}.nodes[${nodeIndex}]`, "Each non-terminal Targeted Talk node must have exactly one fallback transition");
    }
  });

  const terminalReachableFrom = (startId) => {
    const seen = new Set();
    const stack = [startId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (terminalNodeIds.has(current)) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      list(outgoing.get(current)).forEach((target) => stack.push(target));
    }
    return false;
  };
  nodes.forEach((node, nodeIndex) => {
    if (nodeIds.has(node?.id) && !terminalReachableFrom(node.id)) {
      addIssue("gauntlet.node.terminal-unreachable", `${scenarioPath}.nodes[${nodeIndex}]`, "Every Targeted Talk node must be able to reach a terminal node");
    }
  });
}

module.exports = {
  validateTargetedTalkBlueprint,
};