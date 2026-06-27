"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSpineRequest,
  parseSpineResult,
  reviewCallSpine,
  shouldReviewSpine,
} = require("../../packages/shared-services/src/coachNavigator");

test("buildSpineRequest feeds the full transcript + fast-guess phase to the thinker", () => {
  const req = buildSpineRequest({ transcript: "agent: hi\nprospect: I owe 32k", phase: "discovery", captured: ["balance"] });
  assert.match(req.system, /SPINE of the call/);
  assert.match(req.prompt, /Fast-guess phase: discovery/);
  assert.match(req.prompt, /I owe 32k/);
  assert.equal(req.schema.required.includes("accomplished"), true);
});

test("parseSpineResult coerces an unknown phase to null (keep the fast guess)", () => {
  const r = parseSpineResult({ json: { accomplished: ["confirmed identity"], phase: "not_a_phase", nextObjective: "ask balance" } });
  assert.deepEqual(r.accomplished, ["confirmed identity"]);
  assert.equal(r.phase, null);
  assert.equal(r.nextObjective, "ask balance");
});

test("parseSpineResult keeps a valid phase + skill key", () => {
  const r = parseSpineResult({ json: { accomplished: ["quoted $1800 fee"], phase: "payment", nextObjective: "handle cost", suggestedSkillKey: "obj_not_interested", brief: "reframe to value" } });
  assert.equal(r.phase, "payment");
  assert.equal(r.suggestedSkillKey, "obj_not_interested");
  assert.equal(r.brief, "reframe to value");
});

test("reviewCallSpine runs the injected thinker and returns the parsed spine", async () => {
  const runner = async (req) => ({ ok: true, json: { accomplished: ["confirmed identity", "captured balance"], phase: "expert", nextObjective: "frame the three factors" } });
  const spine = await reviewCallSpine({ transcript: "...", phase: "discovery", runner });
  assert.deepEqual(spine.accomplished, ["confirmed identity", "captured balance"]);
  assert.equal(spine.phase, "expert");
});

test("reviewCallSpine never breaks the call — no runner or a throw yields null", async () => {
  assert.equal(await reviewCallSpine({ transcript: "x" }), null); // no runner
  const boom = async () => { throw new Error("spine down"); };
  assert.equal(await reviewCallSpine({ transcript: "x", runner: boom }), null);
});

test("shouldReviewSpine gates on the cadence (off the fast path)", () => {
  assert.equal(shouldReviewSpine(0, undefined, 6), true); // first review fires
  assert.equal(shouldReviewSpine(3, 0, 6), false); // not yet
  assert.equal(shouldReviewSpine(6, 0, 6), true); // cadence reached
  assert.equal(shouldReviewSpine(11, 6, 6), false);
  assert.equal(shouldReviewSpine(12, 6, 6), true);
});
