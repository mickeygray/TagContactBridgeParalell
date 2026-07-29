"use strict";

const GAUNTLET_ATTEMPT_STATUSES = Object.freeze([
  "preparing",
  "ready",
  "in_progress",
  "run_failed",
  "passed",
  "failed",
  "invalidated",
]);

const GAUNTLET_PERSISTED_EVENT_TYPES = Object.freeze([
  "gauntlet_initialized",
  "gauntlet_turn_accepted",
  "gauntlet_turn_rejected",
  "gauntlet_hint_revealed",
  "gauntlet_run_failed",
  "gauntlet_retry_started",
  "gauntlet_invalidated",
]);

const CRITERION_STATUSES = new Set([
  "pending",
  "satisfied",
  "failed",
  "uncertain",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asNullableString(value, label) {
  return value == null ? null : asNonEmptyString(value, label);
}

function asNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeCounterMap(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, count]) => [
    asNonEmptyString(key, `${label} key`),
    asNonNegativeInteger(count, `${label}.${key}`),
  ])));
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const normalized = value.map((entry, index) => asNonEmptyString(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return Object.freeze(normalized);
}

function normalizeCriteria(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("gauntlet state.criteria must be an array");
  }
  const criteria = value.map((criterion, index) => {
    if (!isPlainObject(criterion)) {
      throw new TypeError(`gauntlet state.criteria[${index}] must be an object`);
    }
    const status = asNonEmptyString(criterion.status, `gauntlet state.criteria[${index}].status`);
    if (!CRITERION_STATUSES.has(status)) {
      throw new TypeError(`gauntlet state.criteria[${index}].status is unsupported`);
    }
    return Object.freeze({
      criterionId: asNonEmptyString(criterion.criterionId, `gauntlet state.criteria[${index}].criterionId`),
      ruleId: asNonEmptyString(criterion.ruleId, `gauntlet state.criteria[${index}].ruleId`),
      ruleRevision: asNonEmptyString(criterion.ruleRevision, `gauntlet state.criteria[${index}].ruleRevision`),
      status,
      evidenceTurnIds: normalizeStringList(criterion.evidenceTurnIds, `gauntlet state.criteria[${index}].evidenceTurnIds`),
    });
  });
  const criterionIds = criteria.map((criterion) => criterion.criterionId);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new TypeError("gauntlet state.criteria must not reuse criterion IDs");
  }
  return Object.freeze(criteria);
}

function normalizeGauntletState(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("gauntlet state must be an object");
  }
  if (value.schemaVersion !== "1") {
    throw new TypeError("gauntlet state.schemaVersion is unsupported");
  }
  if (value.experienceMode !== "gauntlet") {
    throw new TypeError("gauntlet state.experienceMode must be gauntlet");
  }
  if (value.direction !== "inbound" && value.direction !== "outbound") {
    throw new TypeError("gauntlet state.direction is unsupported");
  }
  const status = asNonEmptyString(value.status, "gauntlet state.status");
  if (!GAUNTLET_ATTEMPT_STATUSES.includes(status)) {
    throw new TypeError("gauntlet state.status is unsupported");
  }

  return Object.freeze({
    schemaVersion: "1",
    experienceMode: "gauntlet",
    direction: value.direction,
    sectionId: asNonEmptyString(value.sectionId, "gauntlet state.sectionId"),
    status,
    stateVersion: asNonNegativeInteger(value.stateVersion, "gauntlet state.stateVersion"),
    runNumber: asNonNegativeInteger(value.runNumber, "gauntlet state.runNumber"),
    nextTurn: asNonNegativeInteger(value.nextTurn, "gauntlet state.nextTurn"),
    currentNodeId: asNonEmptyString(value.currentNodeId, "gauntlet state.currentNodeId"),
    blueprintId: asNonEmptyString(value.blueprintId, "gauntlet state.blueprintId"),
    blueprintVersion: asNonEmptyString(value.blueprintVersion, "gauntlet state.blueprintVersion"),
    variantId: asNonEmptyString(value.variantId, "gauntlet state.variantId"),
    variantVersion: asNonEmptyString(value.variantVersion, "gauntlet state.variantVersion"),
    promptVersion: asNonEmptyString(value.promptVersion, "gauntlet state.promptVersion"),
    graderVersion: asNonEmptyString(value.graderVersion, "gauntlet state.graderVersion"),
    voiceProfileId: asNonEmptyString(value.voiceProfileId, "gauntlet state.voiceProfileId"),
    audioManifestId: asNonEmptyString(value.audioManifestId, "gauntlet state.audioManifestId"),
    criteria: normalizeCriteria(value.criteria),
    retryByNode: normalizeCounterMap(value.retryByNode, "gauntlet state.retryByNode"),
    hintLevelByNode: normalizeCounterMap(value.hintLevelByNode, "gauntlet state.hintLevelByNode"),
    completedVariantIds: normalizeStringList(value.completedVariantIds, "gauntlet state.completedVariantIds"),
    lastAcceptedEventId: asNullableString(value.lastAcceptedEventId, "gauntlet state.lastAcceptedEventId"),
    invalidationReasonCode: asNullableString(value.invalidationReasonCode, "gauntlet state.invalidationReasonCode"),
  });
}

function reconstructGauntletState(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("gauntlet events must be an array");
  }
  let state = null;
  for (const event of events) {
    if (!GAUNTLET_PERSISTED_EVENT_TYPES.includes(event?.type)) continue;
    if (!isPlainObject(event?.payload?.stateAfter)) {
      throw new TypeError(`gauntlet event ${event?.eventId || "unknown"} is missing stateAfter`);
    }
    state = normalizeGauntletState(event.payload.stateAfter);
  }
  return state;
}

module.exports = {
  GAUNTLET_ATTEMPT_STATUSES,
  GAUNTLET_PERSISTED_EVENT_TYPES,
  normalizeGauntletState,
  reconstructGauntletState,
};
