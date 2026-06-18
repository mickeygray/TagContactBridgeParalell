"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");
const { createAiProviders } = require("../../packages/shared-services/src/aiProviders");
const { extractTextBlocks, extractToolUse } = require("../../packages/shared-integrations/src/anthropicClient");

// ── Fakes ─────────────────────────────────────────────────────────────────────
function fakeAdapter(id, { supports = () => true, run }) {
  return { id, supports, run };
}

// A tiny registry so the runner's logic is tested in isolation from the real
// task table. Tasks are provider-neutral: they only list CAPABLE providers.
function makeRegistry(tasks, { enabled = true } = {}) {
  const validators = {
    needsOk: (r) => (r && r.ok === true ? { ok: true } : { ok: false, reason: "not-ok" }),
  };
  return {
    envKey: (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    getTask: (id) => tasks[id] || null,
    getValidator: (c) => (c ? validators[c] || null : null),
    isEnabled: () => enabled,
  };
}

const composeTask = {
  id: "echo.compose",
  kind: "compose",
  providerOrder: ["anthropic", "openai"],
  models: { anthropic: ["claude-x"], openai: ["gpt-x"] },
  buildRequest: (p) => ({ system: "sys", user: p.text }),
  failClosed: { say: "(unavailable)" },
};

const jsonTask = {
  id: "grade.json",
  kind: "json",
  providerOrder: ["openai", "anthropic"], // default OpenAI; Claude is the backup
  models: { openai: ["gpt-x"], anthropic: ["claude-x"] },
  contract: "needsOk",
  buildRequest: (p) => ({ system: "sys", user: p.text, schema: { type: "object" } }),
  failClosed: { ok: false, reason: "all-down" },
};

// ── 1. happy path: first provider in order serves ─────────────────────────────
test("runs on the first provider in order", async () => {
  const providers = {
    anthropic: fakeAdapter("anthropic", { run: async () => ({ text: "from-claude", model: "claude-x" }) }),
    openai: fakeAdapter("openai", { run: async () => ({ text: "from-openai", model: "gpt-x" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.result, "from-claude");
});

// ── 2. brain swaps to OpenAI when Claude is down (Claude -> OpenAI) ────────────
test("fails over Claude -> OpenAI when anthropic throws", async () => {
  const providers = {
    anthropic: fakeAdapter("anthropic", {
      run: async () => {
        const e = new Error("anthropic 503");
        e.retryable = true;
        throw e;
      },
    }),
    openai: fakeAdapter("openai", { run: async () => ({ text: "from-openai", model: "gpt-x" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai", "should have rolled over to OpenAI");
  assert.equal(r.result, "from-openai");
});

// ── 3. grader swaps to Claude when OpenAI is down (OpenAI -> Claude) ───────────
test("fails over OpenAI -> Claude when openai throws", async () => {
  const providers = {
    openai: fakeAdapter("openai", {
      run: async () => {
        const e = new Error("openai 500");
        e.retryable = true;
        throw e;
      },
    }),
    anthropic: fakeAdapter("anthropic", { run: async () => ({ json: { ok: true, overallScore: 80 }, model: "claude-x" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "grade.json": jsonTask }), env: {} });
  const r = await runAiTask("grade.json", { text: "transcript" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic", "grader should run on Claude when OpenAI is down");
  assert.deepEqual(r.result, { ok: true, overallScore: 80 });
});

// ── 4. forceProvider pins a single provider regardless of order ───────────────
test("options.forceProvider pins the provider", async () => {
  const providers = {
    anthropic: fakeAdapter("anthropic", { run: async () => ({ text: "claude" }) }),
    openai: fakeAdapter("openai", { run: async () => ({ text: "openai" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" }, { forceProvider: "openai" });
  assert.equal(r.provider, "openai");
});

// ── 5. env override flips provider order from one place ───────────────────────
test("env AI_TASK_<ID>_PROVIDER pins from config", async () => {
  const providers = {
    anthropic: fakeAdapter("anthropic", { run: async () => ({ json: { ok: true } }) }),
    openai: fakeAdapter("openai", { run: async () => ({ json: { ok: true } }) }),
  };
  const env = { AI_TASK_GRADE_JSON_PROVIDER: "anthropic" }; // grader normally OpenAI-first
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "grade.json": jsonTask }), env });
  const r = await runAiTask("grade.json", { text: "x" });
  assert.equal(r.provider, "anthropic", "env pin should swap the grader to Claude");
});

// ── 6. contract failure on one provider fails over to the other ───────────────
test("invalid contract output triggers failover, then a valid provider wins", async () => {
  const providers = {
    openai: fakeAdapter("openai", { run: async () => ({ json: { ok: false }, model: "gpt-x" }) }), // fails needsOk
    anthropic: fakeAdapter("anthropic", { run: async () => ({ json: { ok: true }, model: "claude-x" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "grade.json": jsonTask }), env: {} });
  const r = await runAiTask("grade.json", { text: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.attempts.some((a) => a.status === "contract_fail" && a.provider === "openai"), true);
});

// ── 7. both providers down -> fail closed to the task's safe shape ────────────
test("all providers failing returns the fail-closed shape", async () => {
  const down = fakeAdapter("x", {
    run: async () => {
      const e = new Error("down");
      e.retryable = true;
      throw e;
    },
  });
  const providers = { openai: down, anthropic: down };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "grade.json": jsonTask }), env: {} });
  const r = await runAiTask("grade.json", { text: "x" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.safeFallback, { ok: false, reason: "all-down" });
});

// ── 8. disabled task fails closed without calling a provider ──────────────────
test("disabled task short-circuits to fail closed", async () => {
  let called = false;
  const providers = { anthropic: fakeAdapter("anthropic", { run: async () => ((called = true), { text: "x" }) }) };
  const registry = makeRegistry({ "echo.compose": composeTask }, { enabled: false });
  const { runAiTask } = createAiTaskRunner({ providers, registry, env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "disabled");
  assert.equal(called, false);
});

// ── 9. a provider that cannot do the kind is skipped (modality honesty) ───────
test("unsupported kind skips that provider", async () => {
  const transcribeTask = {
    id: "audio.transcribe",
    kind: "transcribe",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-x"], openai: ["whisper"] },
    buildRequest: (p) => p,
  };
  const providers = {
    anthropic: fakeAdapter("anthropic", { supports: (k) => k !== "transcribe", run: async () => ({ text: "nope" }) }),
    openai: fakeAdapter("openai", { supports: () => true, run: async () => ({ json: { text: "heard" } }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "audio.transcribe": transcribeTask }), env: {} });
  const r = await runAiTask("audio.transcribe", {});
  assert.equal(r.provider, "openai");
  assert.equal(r.attempts.some((a) => a.provider === "anthropic" && a.status === "skipped"), true);
});

// ── 10. dryRun returns the resolved request without calling a provider ────────
test("dryRun returns the request and calls nothing", async () => {
  let called = false;
  const providers = { anthropic: fakeAdapter("anthropic", { run: async () => ((called = true), { text: "x" }) }) };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" }, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(called, false);
});

// ── 11. INTEGRATION: real adapters, fake clients — same JSON task on EITHER ────
// Proves the provider-neutral translation: Anthropic emits JSON via tool_use,
// OpenAI via Responses json — the task/runner never know the difference.
test("real adapters: a json task runs on Anthropic (tool_use) and OpenAI (responses) identically", async () => {
  const fakeAnthropicClient = {
    createMessage: async ({ tools }) => ({
      model: "claude-x",
      content: [{ type: "tool_use", name: tools[0].name, input: { status: "stop_contact", confidence: "high" } }],
    }),
    extractTextBlocks,
    extractToolUse,
  };
  const fakeOpenAiClient = {
    createResponse: async () => ({ json: { status: "stop_contact", confidence: "high" }, model: "gpt-x" }),
  };
  const providers = createAiProviders({ anthropic: fakeAnthropicClient, openai: fakeOpenAiClient });

  const realRegistry = require("../../packages/shared-services/src/aiTaskRegistry");
  const payload = { domain: "TAG", caseId: 42, activities: [{ Subject: "Attorney letter", Comment: "cease and desist" }] };

  // default order (anthropic first)
  const a = createAiTaskRunner({ providers, registry: realRegistry, env: {} });
  const viaClaude = await a.runAiTask("activity.contactSafetyReview", payload, { ignoreEnabled: true });
  assert.equal(viaClaude.ok, true);
  assert.equal(viaClaude.provider, "anthropic");
  assert.equal(viaClaude.result.status, "stop_contact");

  // pin to OpenAI — identical contract satisfied
  const viaOpenAi = await a.runAiTask("activity.contactSafetyReview", payload, { ignoreEnabled: true, forceProvider: "openai" });
  assert.equal(viaOpenAi.ok, true);
  assert.equal(viaOpenAi.provider, "openai");
  assert.equal(viaOpenAi.result.status, "stop_contact");
});

// ── 12. (regression) buildRequest throwing fails closed, never crashes ────────
test("buildRequest throwing fails closed instead of crashing the caller", async () => {
  const boom = {
    id: "boom.task",
    kind: "compose",
    providerOrder: ["anthropic"],
    models: { anthropic: ["m"] },
    failClosed: { say: "safe" },
    buildRequest: () => {
      throw new Error("bad payload");
    },
  };
  const providers = { anthropic: fakeAdapter("anthropic", { run: async () => ({ text: "x" }) }) };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "boom.task": boom }), env: {} });
  const r = await runAiTask("boom.task", {});
  assert.equal(r.ok, false);
  assert.match(r.code, /buildRequest_error/);
  assert.deepEqual(r.safeFallback, { say: "safe" });
});

// ── 13. (regression) registry rejects an unknown contract at load ─────────────
test("registry integrity throws on an unknown contract, real registry passes", () => {
  const registry = require("../../packages/shared-services/src/aiTaskRegistry");
  assert.throws(
    () => registry.assertRegistryIntegrity({ t: { id: "t", contract: "does-not-exist" } }, { real: () => {} }),
    /unknown contract/,
  );
  assert.doesNotThrow(() => registry.assertRegistryIntegrity());
});

// ── 14. (regression) OpenAI json path walks the model ladder on non-JSON ──────
test("openaiClient.createResponse retries the ladder on non-JSON then succeeds", async () => {
  const { createOpenAiClient } = require("../../packages/shared-integrations/src/openaiClient");
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const payload = calls === 1 ? { output_text: "sorry, no json here" } : { output_text: '{"ok":true}', model: "gpt-x" };
    return { ok: true, text: async () => JSON.stringify(payload) };
  };
  try {
    const client = createOpenAiClient();
    const r = await client.createResponse({ system: "s", user: "u", json: true });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(calls, 2, "should have advanced to the second model candidate");
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
});

// ── 15. (review #5) an adapter returning nothing usable fails over, never ships undefined
test("adapter returning no json/text/audio fails over instead of shipping undefined", async () => {
  const providers = {
    anthropic: fakeAdapter("anthropic", { run: async () => ({ model: "claude-x", usage: null }) }), // no result field
    openai: fakeAdapter("openai", { run: async () => ({ text: "real", model: "gpt-x" }) }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai", "empty anthropic result should fail over");
  assert.equal(r.result, "real");
  assert.equal(r.attempts.some((a) => a.status === "empty_result" && a.provider === "anthropic"), true);
});

test("empty result on the only provider fails closed (never returns result:undefined)", async () => {
  const providers = { anthropic: fakeAdapter("anthropic", { run: async () => ({ model: "x" }) }) };
  const task = { ...composeTask, providerOrder: ["anthropic"] };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": task }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.safeFallback, { say: "(unavailable)" });
});

// ── 16. (review #3) missing-provider vs unsupported-kind get distinct skip reasons
test("missing provider and unsupported kind get distinct skip reasons", async () => {
  const providers = { openai: fakeAdapter("openai", { supports: () => false, run: async () => ({ text: "x" }) }) };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "echo.compose": composeTask }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.find((a) => a.provider === "anthropic").reason, "provider-not-configured");
  assert.match(r.attempts.find((a) => a.provider === "openai").reason, /unsupported-kind/);
});

// ── 17. (review #4) empty provider order fails closed with a clear code
test("empty provider order fails closed with no_providers_configured", async () => {
  const task = { ...composeTask, providerOrder: [] };
  const { runAiTask } = createAiTaskRunner({ providers: {}, registry: makeRegistry({ "echo.compose": task }), env: {} });
  const r = await runAiTask("echo.compose", { text: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_providers_configured");
});

test("caller-supplied primitive schema validates output and fails over on partial JSON", async () => {
  const primitiveWrite = {
    id: "ai.write",
    kind: "json",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-x"], openai: ["gpt-x"] },
    buildRequest: (p) => ({ system: "sys", user: p.input, schema: p.schema }),
    failClosed: null,
  };
  const schema = {
    type: "object",
    properties: {
      teaser: { type: "string" },
      contentTitle: { type: "string" },
      bodyHtml: { type: "string" },
    },
    required: ["teaser", "contentTitle", "bodyHtml"],
  };
  const providers = {
    anthropic: fakeAdapter("anthropic", {
      run: async () => ({ json: { teaser: "short", contentTitle: "title" }, model: "claude-x" }),
    }),
    openai: fakeAdapter("openai", {
      run: async () => ({ json: { teaser: "short", contentTitle: "title", bodyHtml: "<p>body</p>" }, model: "gpt-x" }),
    }),
  };
  const { runAiTask } = createAiTaskRunner({ providers, registry: makeRegistry({ "ai.write": primitiveWrite }), env: {} });
  const r = await runAiTask("ai.write", { input: "draft", schema });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  assert.equal(r.attempts.some((a) => a.status === "contract_fail" && a.reason === "missing:bodyHtml"), true);
});
