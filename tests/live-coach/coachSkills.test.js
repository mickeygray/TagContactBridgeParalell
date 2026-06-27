"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchSkillKeys, pullSkill } = require("../../packages/shared-services/src/coachSkills");

test("matchSkillKeys pulls the right objection by its keyword", () => {
  assert.ok(matchSkillKeys("eh, honestly i'm not interested, no thanks").includes("obj_not_interested"));
  assert.equal(matchSkillKeys("hello how are you today").length, 0); // no match
});

test("pullSkill returns a near-complete prompt: phase doctrine (90%) + the matched objection playbook", () => {
  const r = pullSkill({ turn: { role: "prospect", text: "honestly i'm not interested, no thanks" }, phase: "discovery" });
  assert.equal(r.source, "objection");
  assert.ok(r.skillKeys.includes("obj_not_interested"));
  assert.match(r.system, /FOCUS — Discovery/); // the always-present phase doctrine
  assert.match(r.system, /Objection detected: Not interested/); // the pulled situation skill
});

test("a miss falls back to the phase doctrine — never all-or-nothing", () => {
  const r = pullSkill({ turn: { role: "prospect", text: "okay tell me more about how this works" }, phase: "pitch" });
  assert.equal(r.source, "phase");
  assert.equal(r.skillKeys.length, 0);
  assert.match(r.system, /FOCUS — Pitch/);
  assert.equal(/Objection detected/.test(r.system), false);
});

test("an override key (the navigator's choice) wins over the deterministic match", () => {
  const r = pullSkill({ turn: { role: "prospect", text: "no keyword here at all" }, phase: "payment", overrideKey: "obj_not_interested" });
  assert.equal(r.source, "objection");
  assert.ok(r.skillKeys.includes("obj_not_interested"));
});

test("an invalid override key falls back to the phase doctrine", () => {
  const r = pullSkill({ turn: { role: "prospect", text: "nothing matches" }, phase: "payment", overrideKey: "not_a_real_key" });
  assert.equal(r.source, "phase");
});
