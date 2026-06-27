"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DETERMINISTIC,
  BATCH,
  HYBRID,
  resolveLiveCoachRuntimeMode,
  usesBatchCoach,
  usesDeterministicComposer,
} = require("../../packages/shared-services/src/liveCoachRuntimeModeService");

test("default (empty env) is deterministic — byte-identical to today", () => {
  const r = resolveLiveCoachRuntimeMode({ agentEmail: "sean@tag.com" }, {});
  assert.equal(r.mode, DETERMINISTIC);
  assert.equal(r.enabled, false);
  assert.equal(usesBatchCoach(r), false);
  assert.equal(usesDeterministicComposer(r), true);
});

test("an agent override alone CANNOT wake the batch loop when the global gate is off", () => {
  const env = { LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES: "sean@tag.com:batch" };
  const r = resolveLiveCoachRuntimeMode({ agentEmail: "sean@tag.com" }, env);
  assert.equal(r.requestedMode, BATCH);
  assert.equal(r.mode, DETERMINISTIC, "degrades to default because batch gate is off");
  assert.match(r.reason, /globally disabled/);
  assert.equal(usesBatchCoach(r), false);
});

test("with the gate ON, the agent override resolves to batch; others stay deterministic", () => {
  const env = {
    LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED: "true",
    LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES: "sean@tag.com:batch",
  };
  const sean = resolveLiveCoachRuntimeMode({ agentEmail: "Sean@TAG.com" }, env); // case-insensitive
  assert.equal(sean.mode, BATCH);
  assert.equal(usesBatchCoach(sean), true);
  assert.equal(usesDeterministicComposer(sean), false, "batch mode suppresses the per-turn composer");

  const dana = resolveLiveCoachRuntimeMode({ agentEmail: "dana@tag.com" }, env);
  assert.equal(dana.mode, DETERMINISTIC, "non-overridden agents stay on the proven path");
});

test("hybrid keeps the deterministic composer running AND uses the batch layer", () => {
  const env = {
    LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED: "true",
    LIVE_COACH_RUNTIME_MODE_DEFAULT: "hybrid",
  };
  const r = resolveLiveCoachRuntimeMode({ agentEmail: "x@y.com" }, env);
  assert.equal(r.mode, HYBRID);
  assert.equal(usesBatchCoach(r), true);
  assert.equal(usesDeterministicComposer(r), true);
});

test("a gated DEFAULT with the gate off degrades all the way to deterministic", () => {
  const env = { LIVE_COACH_RUNTIME_MODE_DEFAULT: "batch" }; // gate unset => off
  const r = resolveLiveCoachRuntimeMode({}, env);
  assert.equal(r.mode, DETERMINISTIC);
});

test("unknown mode tokens are ignored (fall back to default)", () => {
  const env = {
    LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED: "true",
    LIVE_COACH_RUNTIME_MODE_DEFAULT: "turbo",
    LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES: "a@b.com:warp, c@d.com:batch",
  };
  assert.equal(resolveLiveCoachRuntimeMode({ agentEmail: "a@b.com" }, env).mode, DETERMINISTIC, "bad default + bad override -> deterministic");
  assert.equal(resolveLiveCoachRuntimeMode({ agentEmail: "c@d.com" }, env).mode, BATCH, "valid override still honored");
});

test("no agentEmail resolves cleanly to the default", () => {
  const r = resolveLiveCoachRuntimeMode({}, { LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED: "true" });
  assert.equal(r.mode, DETERMINISTIC);
});
