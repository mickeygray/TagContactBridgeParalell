"use strict";

function controllerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertScenarioAndState(scenario, state) {
  if (!scenario || scenario.experienceMode !== "gauntlet") {
    throw controllerError("GAUNTLET_SCENARIO_INVALID");
  }
  if (!state || state.experienceMode !== "gauntlet") {
    throw controllerError("GAUNTLET_STATE_INVALID");
  }
  if (state.blueprintId !== scenario.id || state.blueprintVersion !== scenario.version) {
    throw controllerError("GAUNTLET_PINNED_IDENTITY_MISMATCH");
  }
  if (state.sectionId !== scenario.sectionId || state.direction !== scenario.direction) {
    throw controllerError("GAUNTLET_SECTION_BOUNDARY");
  }
  const variant = (scenario.variants || []).find((entry) => entry.variantId === state.variantId && entry.version === state.variantVersion);
  if (!variant) throw controllerError("GAUNTLET_VARIANT_MISSING");
  return variant;
}

function evaluateCondition(condition, facts) {
  if (!condition) return false;
  if (Array.isArray(condition.all)) return condition.all.every((entry) => evaluateCondition(entry, facts));
  if (Array.isArray(condition.any)) return condition.any.some((entry) => evaluateCondition(entry, facts));
  if (condition.not) return !evaluateCondition(condition.not, facts);
  let actual;
  if (condition.fact === "criterion_state") actual = facts.criteria[condition.criterionId] || "pending";
  else actual = facts[condition.fact];
  switch (condition.op) {
    case "eq": return actual === condition.value;
    case "neq": return actual !== condition.value;
    case "lt": return actual < condition.value;
    case "lte": return actual <= condition.value;
    case "gt": return actual > condition.value;
    case "gte": return actual >= condition.value;
    case "in": return Array.isArray(condition.value) && condition.value.includes(actual);
    default: throw controllerError("GAUNTLET_TRANSITION_INVALID");
  }
}

function allRequiredCriteriaSatisfied(scenario, criteria) {
  return (scenario.nodes || []).flatMap((node) => node.requiredCriteria || []).filter((criterion) => criterion.required).every((criterion) => criteria[criterion.criterionId]?.status === "satisfied");
}

function applyEvidence({ scenario, state, turnId, evidence }) {
  const allowed = new Map(
    (scenario.nodes || [])
      .flatMap((node) => node.requiredCriteria || [])
      .map((criterion) => [criterion.criterionId, criterion]),
  );
  const criteria = Object.fromEntries((state.criteria || []).map((criterion) => [criterion.criterionId, { ...criterion, evidenceTurnIds: [...criterion.evidenceTurnIds] }]));
  for (const proposal of evidence || []) {
    const criterion = allowed.get(proposal.criterionId);
    if (!criterion || proposal.status !== "satisfied" || proposal.ruleId !== criterion.ruleId || proposal.ruleRevision !== criterion.ruleRevision || !Array.isArray(proposal.citedTurnIds) || !proposal.citedTurnIds.includes(turnId)) {
      throw controllerError("GAUNTLET_EVIDENCE_REJECTED");
    }
    const current = criteria[criterion.criterionId];
    if (!current) throw controllerError("GAUNTLET_CRITERION_MISSING");
    criteria[criterion.criterionId] = { ...current, status: "satisfied", evidenceTurnIds: [...new Set([...current.evidenceTurnIds, turnId])] };
  }
  return criteria;
}

function advanceGauntletTurn({ scenario, state, turnId, evidence = [] }) {
  assertScenarioAndState(scenario, state);
  if (state.status !== "ready" && state.status !== "in_progress") throw controllerError("GAUNTLET_NOT_MUTABLE");
  if (typeof turnId !== "string" || !turnId.trim()) throw controllerError("GAUNTLET_TURN_ID_INVALID");
  const currentNode = (scenario.nodes || []).find((node) => node.id === state.currentNodeId);
  if (!currentNode || currentNode.sectionId !== scenario.sectionId || currentNode.type === "terminal") throw controllerError("GAUNTLET_CURRENT_NODE_INVALID");
  const criteria = applyEvidence({ scenario, state, turnId, evidence });
  const retryByNode = { ...state.retryByNode };
  const required = (scenario.nodes || [])
    .flatMap((node) => node.requiredCriteria || [])
    .filter((criterion) => criterion.required !== false);
  if (required.some((criterion) => criteria[criterion.criterionId]?.status !== "satisfied")) {
    retryByNode[currentNode.id] = (retryByNode[currentNode.id] || 0) + 1;
  }
  const facts = {
    criterion_state: undefined,
    criteria: Object.fromEntries(Object.entries(criteria).map(([id, value]) => [id, value.status])),
    retry_count: retryByNode[currentNode.id] || 0,
    run_retry_count: state.runNumber,
    turn_count: state.nextTurn,
    hint_level: state.hintLevelByNode[currentNode.id] || 0,
    hard_fail_code: null,
  };
  const outgoing = (scenario.edges || []).filter((edge) => edge.from === currentNode.id).sort((a, b) => a.priority - b.priority);
  const edge = outgoing.find((entry) => !entry.fallback && evaluateCondition(entry.condition, facts)) || outgoing.find((entry) => entry.fallback);
  if (!edge) throw controllerError("GAUNTLET_TRANSITION_MISSING");
  const nextNode = (scenario.nodes || []).find((node) => node.id === edge.to);
  if (!nextNode || nextNode.sectionId !== scenario.sectionId) throw controllerError("GAUNTLET_SECTION_BOUNDARY");
  const terminal = nextNode.type === "terminal";
  const passed = terminal && allRequiredCriteriaSatisfied(scenario, criteria);
  const nextState = {
    ...state,
    status: terminal ? (passed ? "passed" : "failed") : "in_progress",
    stateVersion: state.stateVersion + 1,
    nextTurn: state.nextTurn + 1,
    currentNodeId: nextNode.id,
    criteria: Object.values(criteria),
    retryByNode,
    lastAcceptedEventId: turnId,
  };
  return Object.freeze({
    nextState: Object.freeze(nextState),
    selectedEdgeId: edge.id,
    reactionIntent: terminal ? null : nextNode.reactionIntent,
    terminal: terminal ? (passed ? "passed" : "failed") : null,
  });
}

function startRetryRun({ scenario, state, eventId }) {
  assertScenarioAndState(scenario, state);
  if (state.status !== "failed" && state.status !== "run_failed") {
    throw controllerError("GAUNTLET_RETRY_NOT_AVAILABLE");
  }
  if ((state.runNumber + 1) > scenario.retryPolicy.runRetryLimit) {
    throw controllerError("GAUNTLET_RETRY_EXHAUSTED");
  }
  if (typeof eventId !== "string" || !eventId.trim()) {
    throw controllerError("GAUNTLET_TURN_ID_INVALID");
  }
  const used = new Set([...(state.completedVariantIds || []), state.variantId]);
  const nextVariant = (scenario.variants || []).find((variant) => !used.has(variant.variantId));
  if (!nextVariant) throw controllerError("GAUNTLET_VARIANTS_EXHAUSTED");
  return Object.freeze({
    ...state,
    status: "ready",
    stateVersion: state.stateVersion + 1,
    runNumber: state.runNumber + 1,
    nextTurn: 1,
    currentNodeId: scenario.startNodeId,
    variantId: nextVariant.variantId,
    variantVersion: nextVariant.version,
    voiceProfileId: nextVariant.voiceProfileId,
    criteria: state.criteria.map((criterion) => ({ ...criterion, status: "pending", evidenceTurnIds: [] })),
    retryByNode: {},
    hintLevelByNode: {},
    completedVariantIds: [...used],
    lastAcceptedEventId: eventId,
  });
}

module.exports = { advanceGauntletTurn, evaluateCondition, startRetryRun };
