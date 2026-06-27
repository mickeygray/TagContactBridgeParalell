"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TAX_GROUP_SCRIPT, TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS } = require("../../packages/shared-services/src/taxGroupScript");

test("SCRIPT_SECTION_IDS is the approved 7-section method incl. the 4B close", () => {
  assert.deepEqual(SCRIPT_SECTION_IDS, ["1", "2", "3", "4", "4B", "5", "6", "7"]);
});

test("every section has id/title/beats; every beat has a stable id/point/detail; beat ids unique per section", () => {
  for (const section of TAX_GROUP_SECTIONS) {
    assert.ok(section.id && section.title, `section ${section.id} has id+title`);
    assert.ok(Array.isArray(section.beats) && section.beats.length, `section ${section.id} has beats`);
    const ids = new Set();
    for (const beat of section.beats) {
      assert.ok(beat.id, `beat in ${section.id} has an id`);
      assert.ok(beat.point, `beat ${beat.id} has a point`);
      assert.ok(beat.detail, `beat ${beat.id} has detail (the static script text)`);
      assert.ok(!ids.has(beat.id), `beat id ${beat.id} is unique within section ${section.id}`);
      ids.add(beat.id);
    }
  }
});

test("structured sections stay consistent with the prose (the model's reference)", () => {
  // The prose TAX_GROUP_SCRIPT is the byte-stable model reference; the structured catalog mirrors it.
  // Guard the headings so the two views can't silently diverge on section identity.
  assert.match(TAX_GROUP_SCRIPT, /1\. INTRODUCTION/);
  assert.match(TAX_GROUP_SCRIPT, /2\. CASE BUILDING/);
  assert.match(TAX_GROUP_SCRIPT, /4B\. PAYMENT TERMS/);
  assert.match(TAX_GROUP_SCRIPT, /7\. CLOSING/);
  // The 4B payment ladder anchor must survive in the prose (the live coach leans on it).
  assert.match(TAX_GROUP_SCRIPT, /\$350/);
  assert.match(TAX_GROUP_SCRIPT, /marathon, not a sprint/);
});
