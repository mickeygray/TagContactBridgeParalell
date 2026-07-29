"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  HARD_RULE_REVISION,
  TAX_RESOLUTION_HARD_RULES,
} = require("../../packages/shared-services/src/trainer-content/taxResolutionHardRules.v1");

test("engraved rules are absolute, run-ending nevers with real authority", () => {
  assert.ok(TAX_RESOLUTION_HARD_RULES.length >= 5);
  for (const rule of TAX_RESOLUTION_HARD_RULES) {
    assert.match(rule.ruleId, /^hard\./);
    assert.equal(rule.kind, "never");
    assert.equal(rule.runEnding, true);
    assert.equal(rule.appliesTo, "all");
    assert.equal(rule.revision, HARD_RULE_REVISION);
    assert.ok(rule.statement.length > 20, `${rule.ruleId}: statement`);
    assert.ok(rule.detectionGuidance.length > 20, `${rule.ruleId}: detectionGuidance`);
    // Authority must point at a file that exists — an engraved rule with no
    // source is invented doctrine wearing a uniform.
    const src = path.join(__dirname, "../../", rule.authority.source);
    assert.ok(fs.existsSync(src), `${rule.ruleId}: authority source missing (${rule.authority.source})`);
    assert.ok(rule.authority.note, `${rule.ruleId}: authority note`);
  }
});

test("the half-promise boundary is engraved", () => {
  const rule = TAX_RESOLUTION_HARD_RULES.find((r) => r.ruleId === "hard.promise-outcome");
  assert.ok(rule);
  assert.match(rule.statement, /half-promise/i);
  // Doing the firm's actual work must never trip the rule.
  assert.match(rule.detectionGuidance, /not a violation/i);
});

test("the preview evaluator enforces engraved rules as run-ending", () => {
  const previewSource = fs.readFileSync(
    path.join(__dirname, "../../scripts/trainer-skill-preview-api.js"),
    "utf8",
  );
  assert.ok(previewSource.includes("TAX_RESOLUTION_HARD_RULES.map((rule) => ({"));
  assert.ok(previewSource.includes('kind: record.lastProhibitedMove.ruleId ? "hard-rule" : "prohibited-move"'));
  assert.ok(previewSource.includes("Either is a run-ending event."));
  assert.ok(previewSource.includes("The boundaries are not: a half-promise, a misstated identity"));
});
