"use strict";

// Opus 4.7+ reject sampling params (temperature/top_p) with a 400. The Anthropic
// client must omit temperature for those models so the Opus-on-bus path works;
// every other model keeps its temperature (incl. the deterministic 0 that
// classify/json tasks rely on). And the bus request builder must carry a declared
// plumbing temperature so it flows explicitly.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelRejectsSamplingParams } = require("../../packages/shared-integrations/src/anthropicClient");
const { toRegistryTask } = require("../../packages/shared-services/src/aiBusRegistry");

test("Opus 4.7+ reject sampling params; opus-4-6 / sonnet / haiku / 3.x do not", () => {
  for (const m of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-8-20250101", "claude-opus-4-10"]) {
    assert.equal(modelRejectsSamplingParams(m), true, `${m} should reject sampling params`);
  }
  for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-5-haiku-latest", "gpt-5.4", ""]) {
    assert.equal(modelRejectsSamplingParams(m), false, `${m} should accept sampling params`);
  }
});

test("buildRequestFor carries a declared plumbing temperature into the request", () => {
  const rt = toRegistryTask({
    id: "t.classify",
    kind: "classify",
    provider: "anthropic",
    system: "s",
    plumbing: { modelDefault: "claude-sonnet-4-6", temperature: 0 },
  });
  const req = rt.buildRequest({ input: "hi" });
  assert.equal(req.temperature, 0, "a declared temperature:0 must flow into the bus request");
});

test("buildRequestFor leaves temperature undefined when none is declared", () => {
  const rt = toRegistryTask({
    id: "t.compose",
    kind: "compose",
    provider: "anthropic",
    system: "s",
    plumbing: { modelDefault: "claude-opus-4-8" },
  });
  const req = rt.buildRequest({ input: "hi" });
  assert.equal(req.temperature, undefined, "no declared temperature => undefined (client omits it for Opus)");
});
