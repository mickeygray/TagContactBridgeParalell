"use strict";

// The coach model-override cache: synchronous per-turn read, default-off
// byte-identical, read-time clamp to a per-component allow-set, tick/ask sub-roles.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../../apps/ai-bus/src/liveCoachModelPolicy");

beforeEach(() => policy.resetCoachPolicy());

test("default-off: with no policy, resolveCoachModel returns the env default verbatim", () => {
  assert.equal(policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(policy.resolveCoachModel("liveCoach.dialogComposer", "tick", "claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("an enabled policy row overrides the model (the marquee gpt-5.4-mini -> gpt-5.4 flip)", () => {
  policy.applyCoachPolicy({ rev: 1, components: { "liveCoach.rollingDigest": { enabled: true, model: "gpt-5.4" } } });
  assert.equal(policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini"), "gpt-5.4");
});

test("enabled:false is inert (returns the env default)", () => {
  policy.applyCoachPolicy({ rev: 2, components: { "liveCoach.rollingDigest": { enabled: false, model: "gpt-5.4" } } });
  assert.equal(policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini"), "gpt-5.4-mini");
});

test("read-time clamp: an out-of-allow id falls back to the env default, never reaches the provider", () => {
  policy.applyCoachPolicy({ rev: 3, components: { "liveCoach.rollingDigest": { enabled: true, model: "gpt-9-imaginary" } } });
  assert.equal(policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini"), "gpt-5.4-mini");
});

test("read-time clamp: a cross-provider id (anthropic on an openai seam) falls back", () => {
  policy.applyCoachPolicy({ rev: 4, components: { "liveCoach.rollingDigest": { enabled: true, model: "claude-opus-4-8" } } });
  assert.equal(policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini"), "gpt-5.4-mini");
});

test("empty/whitespace override falls back to the env default", () => {
  policy.applyCoachPolicy({ rev: 5, components: { "liveCoach.callGrader": { enabled: true, model: "   " } } });
  assert.equal(policy.resolveCoachModel("liveCoach.callGrader", null, "gpt-5.4"), "gpt-5.4");
});

test("dialogComposer resolves tick and ask sub-roles independently", () => {
  policy.applyCoachPolicy({
    rev: 6,
    components: { "liveCoach.dialogComposer": { enabled: true, roles: { tick: "claude-haiku-4-5", ask: "claude-sonnet-4-6" } } },
  });
  assert.equal(policy.resolveCoachModel("liveCoach.dialogComposer", "tick", "claude-sonnet-4-6"), "claude-haiku-4-5");
  assert.equal(policy.resolveCoachModel("liveCoach.dialogComposer", "ask", "claude-opus-4-8"), "claude-sonnet-4-6");
});

test("a tick override outside the tick allow-set falls back to the env default", () => {
  policy.applyCoachPolicy({
    rev: 7,
    components: { "liveCoach.dialogComposer": { enabled: true, roles: { tick: "gpt-5.4" } } }, // openai id on the anthropic tick
  });
  assert.equal(policy.resolveCoachModel("liveCoach.dialogComposer", "tick", "claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("resolveCoachModel is SYNCHRONOUS (no await on the live turn path)", () => {
  assert.equal(policy.resolveCoachModel.constructor.name, "Function", "must not be an AsyncFunction");
  policy.applyCoachPolicy({ rev: 8, components: { "liveCoach.rollingDigest": { enabled: true, model: "gpt-5.4" } } });
  const out = policy.resolveCoachModel("liveCoach.rollingDigest", null, "gpt-5.4-mini");
  assert.equal(typeof out, "string", "returns a value synchronously, not a Promise");
  assert.ok(!(out && typeof out.then === "function"), "must not be a thenable");
});

test("applyCoachPolicy/getCoachPolicyState round-trip the rev + components", () => {
  const state = policy.applyCoachPolicy({ rev: 9, components: { "liveCoach.callGrader": { enabled: true, model: "gpt-5.4-mini" } } });
  assert.equal(state.rev, 9);
  assert.equal(policy.getCoachPolicyState().rev, 9);
  assert.deepEqual(policy.getCoachPolicyState().components["liveCoach.callGrader"], { enabled: true, model: "gpt-5.4-mini" });
});

test("describeCoachComponents marks dialogComposer's tick/ask roles and flat allow-sets", () => {
  const desc = policy.describeCoachComponents();
  const byKey = Object.fromEntries(desc.map((d) => [d.key, d]));
  assert.deepEqual(byKey["liveCoach.dialogComposer"].roles, ["tick", "ask"]);
  assert.ok(byKey["liveCoach.dialogComposer"].allow.tick.includes("claude-sonnet-4-6"));
  assert.equal(byKey["liveCoach.rollingDigest"].roles, null);
  assert.ok(byKey["liveCoach.rollingDigest"].allow.default.includes("gpt-5.4"));
});
