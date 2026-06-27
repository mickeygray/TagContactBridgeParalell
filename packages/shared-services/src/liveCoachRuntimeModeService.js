"use strict";

// Pure runtime resolver for the live coach.
//
// Mirrors cxDialRuntimeModeService: no I/O, `env` injected (defaults to
// process.env), so resolution is a total function of (input, env) and tests need
// zero mocks. This is the switch that lets the proven DETERMINISTIC coach stay
// the default while the new whole-floor BATCH coach is proven per-agent.
//
//   deterministic — today's per-turn pipeline (the proven fallback substrate).
//   batch         — only the whole-floor batch coach drives this agent.
//   hybrid        — deterministic spine runs AND the batch layer adds guidance.
//
// Default is `deterministic`. batch/hybrid degrade BACK to the default unless the
// global LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED gate is on — so an agent override
// alone can never wake the heavy loop (same safety shape as cxDial's bulk_load
// degrade-when-disabled). Default config => byte-identical to today.

const DETERMINISTIC = "deterministic";
const BATCH = "batch";
const HYBRID = "hybrid";

const VALID_MODES = Object.freeze([DETERMINISTIC, BATCH, HYBRID]);
const DEFAULT_MODE = DETERMINISTIC;
// Modes that require the global batch gate to be on.
const GATED_MODES = Object.freeze([BATCH, HYBRID]);
const TRUE_TOKENS = Object.freeze(["1", "true", "yes", "y", "on"]);

function normalizeMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return VALID_MODES.includes(v) ? v : null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return TRUE_TOKENS.includes(String(value).trim().toLowerCase());
}

// "a@x.com:batch, b@x.com:hybrid" -> Map { "a@x.com" => "batch", ... }
// Malformed pairs are skipped, never thrown.
function parseAgentOverrides(raw) {
  const map = new Map();
  for (const pair of String(raw || "").split(",")) {
    const idx = pair.lastIndexOf(":");
    if (idx <= 0) continue;
    const email = normalizeEmail(pair.slice(0, idx));
    const mode = normalizeMode(pair.slice(idx + 1));
    if (email && mode) map.set(email, mode);
  }
  return map;
}

// Parse the three env vars into a plain config. Pure given `env`.
function readRuntimeConfig(env = process.env) {
  return {
    defaultMode: normalizeMode(env.LIVE_COACH_RUNTIME_MODE_DEFAULT) || DEFAULT_MODE,
    batchEnabled: parseBoolean(env.LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED, false),
    agentOverrides: parseAgentOverrides(env.LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES),
  };
}

// The safe fallback: a gated mode degrades to the default; if the default is
// itself gated (misconfig), fall all the way back to deterministic.
function degradedDefault(config) {
  return GATED_MODES.includes(config.defaultMode) ? DETERMINISTIC : config.defaultMode;
}

// Resolve which coach an agent gets. Precedence: per-agent override > default.
// Gate: batch/hybrid only resolve when globally enabled; otherwise they degrade
// to the configured default (never back to the gated mode itself).
function resolveLiveCoachRuntimeMode(input = {}, env = process.env) {
  const config = readRuntimeConfig(env);
  const email = normalizeEmail(input.agentEmail);
  const override = email ? config.agentOverrides.get(email) || null : null;
  const requested = override || config.defaultMode;

  let mode = requested;
  let reason = override
    ? `agent override (${email}) -> ${override}`
    : `default mode -> ${config.defaultMode}`;

  if (GATED_MODES.includes(requested) && !config.batchEnabled) {
    mode = degradedDefault(config);
    reason = `batch globally disabled; degraded to ${mode}`;
  }

  return {
    mode,
    requestedMode: requested,
    reason,
    enabled: config.batchEnabled,
    fallbackMode: DETERMINISTIC,
  };
}

// Does this resolution run the batch coach at all (batch or hybrid)?
function usesBatchCoach(resolution) {
  return Boolean(resolution) && GATED_MODES.includes(resolution.mode);
}

// Does the per-turn deterministic composer still run? (deterministic + hybrid yes; batch no)
function usesDeterministicComposer(resolution) {
  return Boolean(resolution) && resolution.mode !== BATCH;
}

// Narrow projection safe to hand to the client / admin view.
function buildLiveCoachRuntimeMetadata(resolution) {
  return {
    mode: resolution.mode,
    enabled: resolution.enabled,
    reason: resolution.reason,
    fallbackMode: resolution.fallbackMode,
  };
}

module.exports = {
  DETERMINISTIC,
  BATCH,
  HYBRID,
  VALID_MODES,
  DEFAULT_MODE,
  readRuntimeConfig,
  resolveLiveCoachRuntimeMode,
  usesBatchCoach,
  usesDeterministicComposer,
  buildLiveCoachRuntimeMetadata,
};
