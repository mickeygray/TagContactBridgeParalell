"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RIFF_SYSTEM, buildRiffRequest, parseRiff } = require("../../packages/shared-services/src/coachRiff");

test("the riff system grounds the coach in The Tax Group's approved methodology", () => {
  assert.match(RIFF_SYSTEM, /The Tax Group/);
  assert.match(RIFF_SYSTEM, /APPROVED REPRESENTATION METHODOLOGY/);
  assert.match(RIFF_SYSTEM, /ANCHOR FULL first/);
  assert.match(RIFF_SYSTEM, /not a word-for-word script/);
});

test("buildRiffRequest feeds the whole transcript + optional interview", () => {
  const req = buildRiffRequest({ transcript: "agent: hi\nprospect: 1800 is a lot", caseContext: "owes 32k, garnished" });
  assert.match(req.prompt, /Case \(from the agent's interview\): owes 32k, garnished/);
  assert.match(req.prompt, /1800 is a lot/);
});

test("parseRiff returns the guidance or null on empty", () => {
  assert.deepEqual(parseRiff({ json: { read: "r", steer: "s", try: "t" } }), { read: "r", steer: "s", try: "t" });
  assert.equal(parseRiff({ json: { read: "", steer: "", try: "" } }), null);
  assert.equal(parseRiff({ ok: false, error: "x" }), null);
});
