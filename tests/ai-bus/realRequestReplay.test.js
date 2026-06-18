"use strict";

// Sends realistic packets THROUGH the real bus (production registry + runner +
// request-building + contract validation) with SYNTHETIC providers — no keys, no
// spend, deterministic. For each fixture it prints: the input packet, the resolved
// provider/model, the EXACT request the model would receive, and the result that
// comes out the other side — then asserts a valid envelope. Run:
//   node --test tests/ai-bus/realRequestReplay.test.js
// (ignoreEnabled is used here because this is IN-PROCESS; over HTTP the route
// strips it, so the live bus needs the task's AI_TASK_<ID>_ENABLED flag.)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildBusRegistry } = require("../../packages/shared-services/src/aiBusRegistry");
const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");
const { createSyntheticProviders } = require("../../packages/shared-services/src/aiSyntheticProvider");
const fixtures = require("./fixtures/realRequests");

const registry = buildBusRegistry();
const runner = createAiTaskRunner({ providers: createSyntheticProviders(), registry });

function preview(value, n = 280) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

for (const fx of fixtures) {
  test(`packet -> ${fx.taskId} -> result`, async () => {
    const opts = { ...(fx.options || {}), ignoreEnabled: true };

    // 1) Dry run: what the model WOULD receive (no call made).
    const dry = await runner.runAiTask(fx.taskId, fx.payload, { ...opts, dryRun: true });
    assert.equal(dry.dryRun, true, `expected a dryRun resolution, got ${JSON.stringify(dry)}`);
    assert.ok(dry.request, "dryRun must expose the built request");

    // 2) Real run (synthetic provider): what comes out the other side.
    const started = Date.now();
    const out = await runner.runAiTask(fx.taskId, fx.payload, opts);
    const elapsed = Date.now() - started;
    assert.equal(out.ok, true, `task did not succeed: ${JSON.stringify(out)}`);
    assert.ok(out.result !== undefined && out.result !== null, "a result must come out");

    const req = dry.request || {};
    const userIn = req.user ?? req.input ?? req.prompt ?? "(modality payload)";
    console.log(`\n=== ${fx.taskId} ===`);
    console.log(`note      : ${fx.note}`);
    console.log(`IN payload: ${preview(fx.payload)}`);
    console.log(`resolved  : provider=${dry.provider} model=${dry.model} kind=${registry.getTask(fx.taskId).kind}`);
    console.log(`req.system: ${preview(req.system)}`);
    console.log(`req.user  : ${preview(userIn)}`);
    if (req.schema) console.log(`req.schema: ${preview(req.schema, 160)}`);
    console.log(`OUT       : provider=${out.provider} model=${out.model} (${elapsed}ms)`);
    console.log(`OUT result: ${preview(out.result)}`);
  });
}

// A guardrail so the suite proves the contract layer actually runs: the activity
// review's result must satisfy its status enum even from a synthetic provider.
test("activity result satisfies its contract (status enum) end-to-end", async () => {
  const out = await runner.runAiTask(
    "activity.contactSafetyReview",
    fixtures[0].payload,
    { ignoreEnabled: true },
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(
    ["allow_contact", "pause_contact", "stop_contact", "manual_review"].includes(out.result.status),
    `status must be a valid enum, got ${out.result && out.result.status}`,
  );
});
