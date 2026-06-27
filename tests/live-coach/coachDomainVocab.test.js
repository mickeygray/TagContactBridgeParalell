"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DOMAIN_PRIMER, groundDomain } = require("../../packages/shared-services/src/coachDomainVocab");
const { selectComposerSystem } = require("../../packages/shared-services/src/coachComposerSystems");
const { deterministicClean } = require("../../packages/shared-services/src/coachTranscript");

test("the domain primer names the call frame + key terms", () => {
  assert.match(DOMAIN_PRIMER, /tax-resolution sales call for Wynn Tax/);
  assert.match(DOMAIN_PRIMER, /levy/);
  assert.match(DOMAIN_PRIMER, /Form 2848/);
  assert.match(DOMAIN_PRIMER, /interpret it as the most likely tax/); // the grounding instruction
});

test("groundDomain normalizes the company name + notice/form garbles (conservative)", () => {
  assert.equal(groundDomain("i talked to win tax last year"), "i talked to Wynn Tax last year");
  assert.equal(groundDomain("got a c p 504 in the mail"), "got a CP504 in the mail");
  assert.equal(groundDomain("they sent form 28 48"), "they sent Form 2848");
});

test("groundDomain does NOT over-correct real words", () => {
  assert.equal(groundDomain("the winter weather was cold"), "the winter weather was cold"); // 'win' not a word + space + tax
  assert.equal(groundDomain("copy that, 504 area code"), "copy that, 504 area code"); // 'copy' is not 'c p'
});

test("the composer system carries the domain priming (so Haiku grounds garbles, zero latency)", () => {
  const s = selectComposerSystem("payment");
  assert.match(s, /DOMAIN: This is a live tax-resolution sales call for Wynn Tax/);
});

test("deterministicClean applies the domain grounding on the live path", () => {
  assert.equal(deterministicClean("  i called   win tax  about a c p 504  "), "i called Wynn Tax about a CP504");
});
