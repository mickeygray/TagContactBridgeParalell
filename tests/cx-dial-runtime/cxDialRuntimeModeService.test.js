"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCxDialRuntimeMode,
  isCxBulkLoadRuntime,
  buildCxDialRuntimeMetadata,
  SLOW_SINGLE,
  BULK_LOAD,
} = require("../../packages/shared-services/src/cxDialRuntimeModeService");

// ── defaults / empty env ───────────────────────────────────────────────
test("defaults to slow_single when nothing is configured", () => {
  const r = resolveCxDialRuntimeMode({ userEmail: "a@x.com" }, {});
  assert.equal(r.runtime, SLOW_SINGLE);
  assert.equal(r.enabled, false);
  assert.equal(r.fallbackRuntime, SLOW_SINGLE);
});

test("honors CX_DIAL_RUNTIME_DEFAULT", () => {
  const r = resolveCxDialRuntimeMode({}, { CX_DIAL_RUNTIME_DEFAULT: "legacy_emergency" });
  assert.equal(r.runtime, "legacy_emergency");
  assert.equal(r.fallbackRuntime, "legacy_emergency");
});

// ── per-agent overrides ────────────────────────────────────────────────
const ENABLED_ENV = {
  CX_DIAL_RUNTIME_DEFAULT: "slow_single",
  CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true",
  CX_DIAL_RUNTIME_AGENT_OVERRIDES: "mgray@taxadvocategroup.com:bulk_load",
};

test("agent override beats default when bulk_load is globally enabled (case-insensitive email)", () => {
  const r = resolveCxDialRuntimeMode({ userEmail: "MGray@taxadvocategroup.com" }, ENABLED_ENV);
  assert.equal(r.runtime, BULK_LOAD);
  assert.equal(isCxBulkLoadRuntime(r), true);
  assert.equal(r.fallbackRuntime, SLOW_SINGLE);
});

test("non-overridden agents get the default rail", () => {
  const r = resolveCxDialRuntimeMode({ userEmail: "other@x.com" }, ENABLED_ENV);
  assert.equal(r.runtime, SLOW_SINGLE);
  assert.equal(isCxBulkLoadRuntime(r), false);
});

// ── global gate ────────────────────────────────────────────────────────
test("bulk_load override degrades to default when globally disabled", () => {
  const env = { ...ENABLED_ENV, CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "false" };
  const r = resolveCxDialRuntimeMode({ userEmail: "mgray@taxadvocategroup.com" }, env);
  assert.equal(r.runtime, SLOW_SINGLE);
  assert.equal(r.requestedRuntime, BULK_LOAD);
  assert.match(r.reason, /globally disabled/);
});

test("bulk_load as the default also degrades to slow_single when disabled (never resolves to bulk)", () => {
  const env = { CX_DIAL_RUNTIME_DEFAULT: "bulk_load", CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "false" };
  const r = resolveCxDialRuntimeMode({ userEmail: "x@y.com" }, env);
  assert.equal(r.runtime, SLOW_SINGLE);
});

// ── robustness / projection ────────────────────────────────────────────
test("malformed overrides are ignored, not thrown", () => {
  const env = {
    CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true",
    CX_DIAL_RUNTIME_AGENT_OVERRIDES: "garbage,,:bulk_load,x@y.com:nonsense",
  };
  const r = resolveCxDialRuntimeMode({ userEmail: "x@y.com" }, env);
  assert.equal(r.runtime, SLOW_SINGLE); // nonsense runtime ignored -> default
});

test("metadata projection is narrow (no overrides map, no requestedRuntime leak)", () => {
  const r = resolveCxDialRuntimeMode({}, { CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true" });
  const meta = buildCxDialRuntimeMetadata(r);
  assert.deepEqual(Object.keys(meta).sort(), ["enabled", "fallbackRuntime", "reason", "runtime"]);
});
