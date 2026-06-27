"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTurn, deterministicClean } = require("../../packages/shared-services/src/coachTranscript");

test("deterministicClean collapses whitespace and trims (safe, instant)", () => {
  assert.equal(deterministicClean("  not   interested,   no    thanks  "), "not interested, no thanks");
  assert.equal(deterministicClean(""), "");
  assert.equal(deterministicClean(null), "");
});

test("normalizeTurn cleans .text and preserves the original on .raw", async () => {
  const r = await normalizeTurn({ role: "prospect", text: "  not   interested  " });
  assert.equal(r.text, "not interested");
  assert.equal(r.raw, "  not   interested  ");
  assert.equal(r.role, "prospect");
});

test("an injected corrector (translate / heavy grammar) wins; raw still preserved", async () => {
  const corrector = async (turn) => ({ text: "I am not interested" }); // e.g. ES->EN translate
  const r = await normalizeTurn({ role: "prospect", text: "no estoy interesado" }, { corrector });
  assert.equal(r.text, "I am not interested");
  assert.equal(r.raw, "no estoy interesado"); // original kept for display
});

test("a corrector that throws falls back to the deterministic clean (never blocks/breaks)", async () => {
  const corrector = async () => { throw new Error("corrector down"); };
  const r = await normalizeTurn({ text: "  hi  there  " }, { corrector });
  assert.equal(r.text, "hi there");
});

test("an empty corrector result falls back to the deterministic clean", async () => {
  const corrector = async () => ({ text: "   " });
  const r = await normalizeTurn({ text: "real words" }, { corrector });
  assert.equal(r.text, "real words");
});
