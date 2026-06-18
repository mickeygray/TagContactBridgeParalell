"use strict";

// Regression: the production bus registry must give EVERY provider in a task's
// providerOrder a REAL model id — never a "<provider>-model" placeholder. A
// placeholder on the failover provider makes bidirectional failover die at
// adapter.run (the bus's whole "accepts either provider" promise). This locks
// the fix in aiBusRegistry.failoverLadder / toRegistryTask.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildBusRegistry, toRegistryTask } = require("../../packages/shared-services/src/aiBusRegistry");
const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");

const PLACEHOLDER = /-model$/; // matches "anthropic-model" / "openai-model" / "model"
const KNOWN_PROVIDERS = new Set(["anthropic", "openai"]);

test("no task in the live registry resolves a placeholder model on ANY provider", () => {
  const registry = buildBusRegistry();
  const offenders = [];
  for (const task of registry.listTasks()) {
    for (const provider of task.providerOrder || []) {
      const ladder = (task.models && task.models[provider]) || [];
      assert.ok(ladder.length >= 1, `${task.id}/${provider} has an empty model ladder`);
      for (const m of ladder) {
        if (PLACEHOLDER.test(m) || m === "model") offenders.push(`${task.id}/${provider}=${m}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `placeholder models would break failover: ${offenders.join(", ")}`);
});

test("a reasoning task lists BOTH providers, each with a real failover model", () => {
  // activity.contactSafetyReview is anthropic-primary; its failover is openai.
  const registry = buildBusRegistry();
  const task = registry.getTask("activity.contactSafetyReview");
  assert.ok(task, "activity.contactSafetyReview should be a live named task");
  assert.equal(task.providerOrder.length, 2, "reasoning task keeps both providers for failover");
  for (const provider of task.providerOrder) {
    assert.ok(KNOWN_PROVIDERS.has(provider));
    const m = task.models[provider][0];
    assert.ok(m && !PLACEHOLDER.test(m), `${provider} failover model must be real, got ${m}`);
  }
});

test("plumbing.failoverModels overrides the default failover ladder", () => {
  const rt = toRegistryTask({
    id: "demo.task",
    kind: "json",
    provider: "anthropic",
    system: "x",
    plumbing: { modelDefault: "claude-opus-4-8", failoverModels: { openai: ["gpt-5.4", "gpt-5.4-mini"] } },
  });
  assert.deepEqual(rt.models.anthropic, ["claude-opus-4-8"]);
  assert.deepEqual(rt.models.openai, ["gpt-5.4", "gpt-5.4-mini"], "declared failover ladder wins");
});

test("on a real primary outage the runner fails over to the secondary with a USABLE model", async () => {
  // Prove the placeholder fix end-to-end: anthropic (primary) throws, the runner
  // must reach openai with a real model and succeed — not call "openai-model".
  const registry = buildBusRegistry();
  const seen = [];
  const providers = {
    anthropic: { supports: () => true, run: async () => { throw new Error("503 anthropic down"); } },
    openai: {
      supports: () => true,
      run: async (kind, req, { model }) => { seen.push({ provider: "openai", model }); return { json: { status: "manual_review", confidence: "low" }, model }; },
    },
  };
  const runner = createAiTaskRunner({ providers, registry, telemetry: null });
  const out = await runner.runAiTask(
    "activity.contactSafetyReview",
    { domain: "TAG", caseId: 1, activities: [{ Comment: "x" }] },
    { ignoreEnabled: true, validate: () => ({ ok: true }) }, // isolate failover-model resolution from the contract
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(seen.length, 1, "failover hit openai exactly once");
  assert.ok(!PLACEHOLDER.test(seen[0].model), `failover used a real model, not a placeholder: ${seen[0].model}`);
});
