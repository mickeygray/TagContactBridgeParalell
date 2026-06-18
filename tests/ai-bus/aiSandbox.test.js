"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const sandbox = require("../../packages/shared-services/src/aiSandbox");

// ── the cp'd .md files actually loaded (non-empty) ───────────────────────────
test("file-based prompts loaded from the cp'd .md files", () => {
  for (const key of ["UNIVERSAL_SALES_SCRIPT", "RESOLUTION_PITCH_DOCTRINE", "SALES_TRAINER_FULL", "SALES_TRAINER_LIVE_TURN"]) {
    assert.ok(sandbox.prompts[key] && sandbox.prompts[key].length > 200, `${key} should be a non-empty prompt`);
  }
});

// ── verbatim prompts present + carry their distinctive markers ───────────────
test("verbatim inline prompts copied faithfully", () => {
  assert.match(sandbox.prompts.CONTEXT_JUDGE_PROMPT, /semantic context judge/);
  assert.match(sandbox.prompts.ROLLING_DIGEST_PROMPT, /rolling relevance reader/);
  assert.match(sandbox.prompts.CALL_GRADER_PROMPT, /call grader for a tax-resolution sales floor/);
  assert.match(sandbox.prompts.CALL_STRATEGIST_INSTRUCTIONS, /pre-call strategist/);
  assert.match(sandbox.prompts.SMS_CLASSIFIER_SYSTEM, /Wynn Tax Solutions/);
  assert.match(sandbox.prompts.SMS_CLASSIFIER_SYSTEM, /dnc_confirm/);
  assert.match(sandbox.prompts.ACTIVITY_REVIEW_SYSTEM, /contact safety/);
  assert.match(sandbox.prompts.SCORING_SYSTEM_PROMPT, /LEAD QUALITY/);
});

// ── core reasoning tasks are FULLY populated (the build-around guarantee) ─────
const CORE_TASKS = [
  "liveCoach.callStrategy",
  "liveCoach.rollingDigest",
  "liveCoach.contextJudge",
  "liveCoach.callGrader",
  "sms.classify",
  "activity.contactSafetyReview",
  "resolution.pitch",
  "transcriptionScoring.score",
];

test("every core task has a non-empty prompt + plumbing (schema where structured)", () => {
  for (const id of CORE_TASKS) {
    const t = sandbox.getSandboxTask(id);
    assert.ok(t, `${id} should exist`);
    assert.ok(typeof t.system === "string" && t.system.length > 50, `${id} system prompt should be populated`);
    assert.ok(t.plumbing && t.plumbing.modelDefault, `${id} should carry model plumbing`);
    if (t.kind === "json" || t.kind === "classify") {
      assert.ok(t.schema, `${id} (${t.kind}) should carry a schema`);
    }
    assert.ok("cache" in t, `${id} should declare a cache policy (null is fine)`);
  }
});

// ── the SMS tool schema's controlled vocabulary survived the copy ────────────
test("sms.classify tool schema keeps its tier + state enums", () => {
  const tool = sandbox.schemas.SMS_CLASSIFY_TOOL;
  assert.equal(tool.name, "classify_sms");
  assert.deepEqual(tool.input_schema.properties.tier.enum, sandbox.rules.SMS_TIERS);
  assert.deepEqual(tool.input_schema.properties.prospect_state.enum, sandbox.rules.SMS_PROSPECT_STATES);
  assert.equal(tool.input_schema.required.length, 9);
});

// ── cache identity preserved for the cached tasks ────────────────────────────
test("cache keys preserved for the warm-prefix tasks", () => {
  assert.equal(sandbox.cache["liveCoach.rollingDigest"].openai.promptCacheKey, "live-coach-rolling-digest:digest-v2");
  assert.equal(sandbox.cache["liveCoach.callStrategy"].anthropic.ephemeralSystem, true);
  assert.equal(sandbox.cache["sms.classify"], null);
});

// ── the whole table loads + lists ────────────────────────────────────────────
test("sandbox exposes the full task table", () => {
  const all = sandbox.listSandboxTasks();
  assert.ok(all.length >= 20, "should hold the full task set");
  // every task at least declares id/verb/kind/provider
  for (const t of all) {
    assert.ok(t.id && t.verb && t.kind && t.provider, `task ${t.id} missing core fields`);
  }
});
