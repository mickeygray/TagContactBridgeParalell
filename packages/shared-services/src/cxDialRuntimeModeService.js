"use strict";

// Pure runtime resolver for the CX dial rails.
//
// No I/O: `env` is injected (defaults to process.env) so resolution is a total
// function of (input, env) and tests need zero mocks. This is the shared gate
// every rail sits behind — see docs/CX_DUAL_RAIL_CLEAN_CODE_PLAN.md
// "## Runtime Selector". Per the Document Map this server resolver is the
// later-phase live-floor canary; the primary v1 switch is the client build flag.

const SLOW_SINGLE = "slow_single";
const BULK_LOAD = "bulk_load";
const LEGACY_EMERGENCY = "legacy_emergency";

const VALID_RUNTIMES = Object.freeze([SLOW_SINGLE, BULK_LOAD, LEGACY_EMERGENCY]);
const DEFAULT_RUNTIME = SLOW_SINGLE;
const TRUE_TOKENS = Object.freeze(["1", "true", "yes", "y", "on"]);

function normalizeRuntime(value) {
  const v = String(value || "").trim().toLowerCase();
  return VALID_RUNTIMES.includes(v) ? v : null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return TRUE_TOKENS.includes(String(value).trim().toLowerCase());
}

// "a@x.com:bulk_load, b@x.com:slow_single" -> Map { "a@x.com" => "bulk_load", ... }
// Malformed pairs are skipped, never thrown.
function parseAgentOverrides(raw) {
  const map = new Map();
  for (const pair of String(raw || "").split(",")) {
    const idx = pair.lastIndexOf(":");
    if (idx <= 0) continue;
    const email = normalizeEmail(pair.slice(0, idx));
    const runtime = normalizeRuntime(pair.slice(idx + 1));
    if (email && runtime) map.set(email, runtime);
  }
  return map;
}

// Parse the three env vars into a plain config. Pure given `env`.
function readRuntimeConfig(env = process.env) {
  return {
    defaultRuntime: normalizeRuntime(env.CX_DIAL_RUNTIME_DEFAULT) || DEFAULT_RUNTIME,
    bulkLoadEnabled: parseBoolean(env.CX_DIAL_RUNTIME_BULK_LOAD_ENABLED, false),
    agentOverrides: parseAgentOverrides(env.CX_DIAL_RUNTIME_AGENT_OVERRIDES),
  };
}

// The safe fallback rail: bulk_load falls back to slow_single; slow/legacy are
// already their own floor.
function fallbackFor(runtime) {
  return runtime === BULK_LOAD ? SLOW_SINGLE : runtime;
}

// Resolve which rail an agent gets. Precedence: per-agent override > default.
// Gate: bulk_load only resolves when globally enabled; otherwise it degrades to
// the configured default (never back to bulk_load itself).
function resolveCxDialRuntimeMode(input = {}, env = process.env) {
  const config = readRuntimeConfig(env);
  const email = normalizeEmail(input.userEmail);
  const override = email ? config.agentOverrides.get(email) || null : null;
  const requested = override || config.defaultRuntime;

  let runtime = requested;
  let reason = override
    ? `agent override (${email}) -> ${override}`
    : `default runtime -> ${config.defaultRuntime}`;

  if (requested === BULK_LOAD && !config.bulkLoadEnabled) {
    runtime = config.defaultRuntime === BULK_LOAD ? SLOW_SINGLE : config.defaultRuntime;
    reason = `bulk_load globally disabled; degraded to ${runtime}`;
  }

  return {
    runtime,
    requestedRuntime: requested,
    reason,
    enabled: config.bulkLoadEnabled,
    fallbackRuntime: fallbackFor(runtime),
  };
}

function isCxBulkLoadRuntime(resolution) {
  return Boolean(resolution) && resolution.runtime === BULK_LOAD;
}

// Narrow projection safe to hand to the client / admin view.
function buildCxDialRuntimeMetadata(resolution) {
  return {
    runtime: resolution.runtime,
    enabled: resolution.enabled,
    reason: resolution.reason,
    fallbackRuntime: resolution.fallbackRuntime,
  };
}

module.exports = {
  SLOW_SINGLE,
  BULK_LOAD,
  LEGACY_EMERGENCY,
  VALID_RUNTIMES,
  DEFAULT_RUNTIME,
  resolveCxDialRuntimeMode,
  isCxBulkLoadRuntime,
  buildCxDialRuntimeMetadata,
};
