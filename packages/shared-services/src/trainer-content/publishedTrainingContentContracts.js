"use strict";

const CONTENT_STATUSES = Object.freeze(["draft", "published", "retired"]);
const RULE_AUTHORITY_TYPES = Object.freeze([
  "mickey-ruling",
  "approved-tax-resolution-script",
  "model-consideration",
  "test-fixture",
]);
const DETERMINISTIC_AUTHORITY_TYPES = Object.freeze([
  "mickey-ruling",
  "approved-tax-resolution-script",
]);
const COURSE_ITEM_TYPES = Object.freeze([
  "lesson",
  "quiz",
  "say-it",
  "gauntlet",
  "free-call",
  "reflection",
]);
const SCENARIO_NODE_TYPES = Object.freeze([
  "prospect",
  "agent-response",
  "checkpoint",
  "terminal",
]);
const SCENARIO_EXPERIENCE_MODES = Object.freeze(["gauntlet", "free"]);
const SCENARIO_DELIVERY_MODES = Object.freeze([
  "voice-required",
  "voice-dynamic",
  "text-only-test",
]);
const TRANSITION_FACTS = Object.freeze([
  "criterion_state",
  "retry_count",
  "run_retry_count",
  "turn_count",
  "hint_level",
  "hard_fail_code",
]);
const TRANSITION_OPERATORS = Object.freeze([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
]);
const OVERLAY_SCOPE_KEYS = Object.freeze(["company", "direction"]);
const DIRECTIONS = Object.freeze(["inbound", "outbound"]);

module.exports = {
  CONTENT_STATUSES,
  RULE_AUTHORITY_TYPES,
  DETERMINISTIC_AUTHORITY_TYPES,
  COURSE_ITEM_TYPES,
  SCENARIO_NODE_TYPES,
  SCENARIO_EXPERIENCE_MODES,
  SCENARIO_DELIVERY_MODES,
  TRANSITION_FACTS,
  TRANSITION_OPERATORS,
  OVERLAY_SCOPE_KEYS,
  DIRECTIONS,
};
