"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const previewSource = fs.readFileSync(
  path.resolve(__dirname, "../../scripts/trainer-skill-preview-api.js"),
  "utf8",
);

test("local skill preview uses a model prospect that hears the actual conversation", () => {
  assert.match(previewSource, /createAnthropicClient/);
  assert.match(previewSource, /conversationSoFar: conversationText\(record\)/);
  assert.match(previewSource, /newestAgentUtterance: learnerText/);
  assert.match(previewSource, /Stay fully in character/);
  assert.match(previewSource, /The section boundary limits the topic/);
  assert.match(previewSource, /Never coach, grade, name rubric criteria/);
});

test("preview grading remains separate and never advances one criterion per turn", () => {
  assert.match(previewSource, /gradeLearnerTurn\(record, text\)/);
  assert.match(previewSource, /generateProspectReply\(record, text\)/);
  assert.match(previewSource, /record\.satisfiedCriterionIds\.add\(criterionId\)/);
  assert.doesNotMatch(previewSource, /satisfiedCount\s*\+\s*1/);
});

test("direction-specific criteria are filtered before the short section begins", () => {
  assert.match(previewSource, /function activeCriteria\(record\)/);
  assert.match(
    previewSource,
    /!requiredDirection \|\| requiredDirection === record\.direction/,
  );
});
