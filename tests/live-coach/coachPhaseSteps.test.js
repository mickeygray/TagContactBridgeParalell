"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PHASE_STEPS,
  phaseSteps,
  recognizeSteps,
  stepChecklist,
  pendingSteps,
} = require("../../packages/shared-services/src/coachPhaseSteps");

const agent = (text) => ({ role: "agent", text });
const prospect = (text) => ({ role: "prospect", text });

test("intro has the three named beats", () => {
  assert.deepEqual(
    phaseSteps("intro").map((s) => s.id),
    ["identify_self", "identify_company", "confirm_prospect"]
  );
});

test("recognizeSteps fires the intro beats on the agent's opener", () => {
  assert.ok(recognizeSteps(agent("Hi, this is Marcus calling from Wynn Tax — am I speaking with Linda?"))
    .has("identify_self"));
  assert.ok(recognizeSteps(agent("Hi, this is Marcus calling from Wynn Tax — am I speaking with Linda?"))
    .has("identify_company"));
  assert.ok(recognizeSteps(agent("Hi, this is Marcus calling from Wynn Tax — am I speaking with Linda?"))
    .has("confirm_prospect"));
});

test("a partial opener only completes the beats it actually hits", () => {
  const done = recognizeSteps(agent("Hi, this is Marcus — how are you today?"));
  assert.ok(done.has("identify_self"));
  assert.equal(done.has("identify_company"), false); // never named the firm
  assert.equal(done.has("confirm_prospect"), false); // never confirmed who he's talking to
});

test("recognizeSteps ignores prospect turns (steps are agent beats)", () => {
  assert.equal(recognizeSteps(prospect("This is Linda, who's calling?")).size, 0);
});

test("stepChecklist marks done vs pending for the current phase", () => {
  const list = stepChecklist("intro", ["identify_self"]);
  assert.deepEqual(list, [
    { id: "identify_self", label: "Identify yourself", done: true },
    { id: "identify_company", label: "Name the firm", done: false },
    { id: "confirm_prospect", label: "Confirm the prospect", done: false },
  ]);
});

test("pendingSteps is the nudge source — the not-yet-done beats", () => {
  const pending = pendingSteps("intro", new Set(["identify_self"]));
  assert.deepEqual(pending.map((s) => s.id), ["identify_company", "confirm_prospect"]);
  // all done -> nothing to nudge
  assert.equal(pendingSteps("intro", new Set(["identify_self", "identify_company", "confirm_prospect"])).length, 0);
});

test("payment / pitch beats are recognized from the script", () => {
  assert.ok(recognizeSteps(agent("The flat legal fee is $1,800.")).has("state_fee"));
  assert.ok(recognizeSteps(agent("Most clients take care of it all at once.")).has("anchor_full"));
  assert.ok(recognizeSteps(agent("We file a Power of Attorney, Form 2848, to get you represented.")).has("explain_forms"));
  assert.ok(recognizeSteps(agent("Think of it as a marathon, not a sprint.")).has("set_expectation"));
});

test("every phase the machine knows has a step checklist", () => {
  // guards against a phase being added to the machine but left without beats
  for (const phaseId of ["intro", "discovery", "expert", "pitch", "payment", "info", "close"]) {
    assert.ok(Array.isArray(PHASE_STEPS[phaseId]) && PHASE_STEPS[phaseId].length > 0, `${phaseId} has steps`);
  }
});
