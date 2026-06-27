"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRiffLibrarySystem, formatObjectionsSection, TAX_SECTION } = require("../../packages/shared-services/src/coachReferenceLibrary");

test("the reference is organized into method backbone + three broad sections", () => {
  const sys = buildRiffLibrarySystem();
  assert.match(sys, /The Tax Group/); // riff framing
  assert.match(sys, /THE TAX GROUP — APPROVED REPRESENTATION METHODOLOGY/); // backbone
  assert.match(sys, /SITUATIONAL TACTICS/); // tactics list
  assert.match(sys, /OBJECTIONS — the play for each/); // objections list
  assert.match(sys, /TAX \(answer generally/); // tax list
});

test("section order: method -> tactics -> objections -> tax", () => {
  const sys = buildRiffLibrarySystem();
  const a = sys.indexOf("APPROVED REPRESENTATION METHODOLOGY");
  const b = sys.indexOf("SITUATIONAL TACTICS");
  const c = sys.indexOf("OBJECTIONS — the play for each");
  const d = sys.indexOf("TAX (answer generally");
  assert.ok(a < b && b < c && c < d, `order off: ${a},${b},${c},${d}`);
});

test("the objections list is terse (one line per objection, no doctrine header)", () => {
  const obj = formatObjectionsSection();
  assert.match(obj, /Move:/);
  assert.match(obj, /Ex:/);
  assert.equal(/Objection doctrine:/.test(obj), false); // doctrine dropped (mechanics live in tactics)
  // DNC stays terminal
  assert.match(obj, /TERMINAL — honor immediately/);
});

test("tax stays general — representation/compliance, never a guaranteed outcome", () => {
  assert.match(TAX_SECTION, /CP504/);
  assert.match(TAX_SECTION, /2848.*8821/s);
  assert.match(TAX_SECTION, /NEVER promise/);
  assert.match(TAX_SECTION, /answer generally/);
});

test("the trim landed — meaningfully smaller than the over-fleshed version but still substantial", () => {
  const n = buildRiffLibrarySystem().length;
  assert.ok(n > 18000, `too thin, lost angles? ${n}`);
  assert.ok(n < 45000, `still bloated? ${n}`); // was ~51k
});
