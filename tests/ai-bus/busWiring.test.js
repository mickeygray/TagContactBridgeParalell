"use strict";

// Proves the production wiring chain — real shared clients → providers → runner →
// route handler — constructs and serves a dryRun, without booting the 4388-line
// server (no network, no Mongo).
//
// NOTE: the dryRun test below uses the BASE registry (aiTaskRegistry), where
// primitives are default-ON, purely so ai.read resolves without ignoreEnabled.
// The LIVE server mounts buildBusRegistry() instead, where primitives are
// default-OFF — the separate test at the bottom asserts that production property
// so this file doesn't overstate what's enabled in prod.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAnthropicClient } = require("../../packages/shared-integrations/src/anthropicClient");
const { createOpenAiClient } = require("../../packages/shared-integrations/src/openaiClient");
const { createAiProviders } = require("../../packages/shared-services/src/aiProviders");
const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");
const registry = require("../../packages/shared-services/src/aiTaskRegistry");
const { buildBusRegistry } = require("../../packages/shared-services/src/aiBusRegistry");
const { mountAiTaskRoutes, runTask } = require("../../apps/ai-bus/src/aiTaskRoutes");

function buildRunner() {
  const providers = createAiProviders({ anthropic: createAnthropicClient(), openai: createOpenAiClient() });
  return createAiTaskRunner({ providers, registry });
}

test("production wiring constructs and registers the 3 routes", () => {
  const runner = buildRunner();
  const app = {
    routes: [],
    get(p) {
      this.routes.push(["GET", p]);
    },
    post(p) {
      this.routes.push(["POST", p]);
    },
  };
  mountAiTaskRoutes(app, { runner, registry, allowUnauthenticated: true }); // local/test only
  assert.ok(app.routes.some(([m, p]) => m === "POST" && p === "/api/ai/tasks/:taskId/run"));
  assert.ok(app.routes.some(([m, p]) => m === "GET" && p === "/api/ai/tasks"));
  assert.ok(app.routes.some(([m, p]) => m === "GET" && p === "/api/ai/tasks/:taskId"));
});

test("real registry + runner serve a dryRun through the route handler", async () => {
  const runner = buildRunner();
  const r = await runTask(runner, "ai.read", { payload: { input: "hi" }, options: { dryRun: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dryRun, true);
  assert.equal(typeof r.json.timing.busMs, "number");
});

// The property the live server actually relies on: in the PRODUCTION registry
// (buildBusRegistry), every ai.* primitive is default-OFF (no spend leak). The
// base-registry dryRun above does NOT prove this — this does.
test("production registry has every ai.* primitive default-OFF", () => {
  const prod = buildBusRegistry();
  const primitives = prod.listTasks().filter((t) => t.family === "primitive");
  assert.ok(primitives.length > 0, "expected ai.* primitives in the production registry");
  for (const t of primitives) {
    assert.equal(prod.isEnabled(t, {}), false, `${t.id} must be default-OFF in production (empty env)`);
  }
});

// The route boundary must NOT let a client bypass the default-off gate. ai.read is
// default-OFF in the production registry; a client passing ignoreEnabled over the
// wire must still be refused (the runner only sees a sanitized options object).
test("runTask strips client-supplied ignoreEnabled (no default-off bypass over HTTP)", async () => {
  const prod = buildBusRegistry();
  const providers = { anthropic: { supports: () => true, run: async () => ({ json: {} }) }, openai: { supports: () => true, run: async () => ({ json: {} }) } };
  const runner = createAiTaskRunner({ providers, registry: prod });
  const r = await runTask(runner, "ai.read", { payload: { input: "x" }, options: { ignoreEnabled: true, dryRun: true } });
  assert.equal(r.json.ok, false, "ignoreEnabled must be stripped, so the disabled task fails closed");
  assert.equal(r.json.code, "disabled");
  // ...while an in-process caller CAN still bypass (proves the boundary, not the gate, changed):
  const direct = await runner.runAiTask("ai.read", { input: "x" }, { ignoreEnabled: true, dryRun: true });
  assert.equal(direct.ok, true);
  assert.equal(direct.dryRun, true);
});

// Caller-disconnect must stop the runner before it starts another paid attempt.
test("runner short-circuits to caller_aborted when the signal is already aborted", async () => {
  const prod = buildBusRegistry();
  let providerCalls = 0;
  const providers = {
    anthropic: { supports: () => true, run: async () => { providerCalls++; throw new Error("down"); } },
    openai: { supports: () => true, run: async () => { providerCalls++; return { json: { status: "manual_review", confidence: "low" } }; } },
  };
  const runner = createAiTaskRunner({ providers, registry: prod });
  const ac = new AbortController();
  ac.abort(); // caller already gave up
  const out = await runner.runAiTask(
    "activity.contactSafetyReview",
    { domain: "TAG", caseId: 1, activities: [{ Comment: "x" }] },
    { ignoreEnabled: true, signal: ac.signal, validate: () => ({ ok: true }) },
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, "caller_aborted");
  assert.equal(providerCalls, 0, "no provider should be billed after the caller aborts");
});
