"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");
const { createAiPrimitives } = require("../../packages/shared-services/src/aiPrimitives");
const { createAiProviders } = require("../../packages/shared-services/src/aiProviders");
const registry = require("../../packages/shared-services/src/aiTaskRegistry");

// Fake provider adapters — record what kind/request/model they were handed.
function spyAdapter(id, impl, { supports = () => true } = {}) {
  const calls = [];
  return {
    adapter: {
      id,
      supports,
      run: async (kind, request, opts) => {
        calls.push({ kind, request, model: opts.model });
        return impl(kind, request, opts);
      },
    },
    calls,
  };
}

function harness({ anthropic, openai, telemetry } = {}) {
  const providers = {};
  const spies = {};
  if (anthropic) {
    const s = spyAdapter("anthropic", anthropic.impl, anthropic.opts);
    providers.anthropic = s.adapter;
    spies.anthropic = s;
  }
  if (openai) {
    const s = spyAdapter("openai", openai.impl, openai.opts);
    providers.openai = s.adapter;
    spies.openai = s;
  }
  const runner = createAiTaskRunner({ providers, registry, telemetry, env: {} });
  return { primitives: createAiPrimitives({ runner }), spies };
}

// ── aiWrite: atomic prompt, default provider ──────────────────────────────────
test("aiWrite({prompt}) composes on the default provider", async () => {
  const { primitives, spies } = harness({
    anthropic: { impl: async () => ({ text: "blog copy", model: "claude-x" }) },
    openai: { impl: async () => ({ text: "should-not-run", model: "gpt-x" }) },
  });
  const r = await primitives.aiWrite({ prompt: "Write a 2-line intro about IRS notices." });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.result, "blog copy");
  assert.equal(spies.anthropic.calls[0].kind, "compose");
  assert.equal(spies.anthropic.calls[0].request.user, "Write a 2-line intro about IRS notices.");
});

// ── aiRead: structured comprehension via schema.output ────────────────────────
test("aiRead({prompt, schema:{output}}) returns structured json", async () => {
  const shape = { type: "object", properties: { topic: { type: "string" } } };
  const { primitives, spies } = harness({
    anthropic: { impl: async () => ({ json: { topic: "levy" }, model: "claude-x" }) },
  });
  const r = await primitives.aiRead({ prompt: "Classify this message.", schema: { output: shape } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { topic: "levy" });
  assert.deepEqual(spies.anthropic.calls[0].request.schema, shape);
});

// ── aiWrite becomes structured GENERATION when given schema.output ────────────
test("aiWrite({schema:{output}}) flips to structured json generation", async () => {
  const shape = { type: "object", properties: { teaser: { type: "string" } } };
  const { primitives, spies } = harness({
    anthropic: { impl: async () => ({ json: { teaser: "hello" }, model: "claude-x" }) },
  });
  const r = await primitives.aiWrite({ prompt: "Draft a teaser.", schema: { output: shape } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { teaser: "hello" });
  assert.equal(spies.anthropic.calls[0].kind, "json", "schema.output should flip aiWrite to json");
  assert.deepEqual(spies.anthropic.calls[0].request.schema, shape);
});

// ── platform is a PREFERENCE: tried first, but still fails over ───────────────
test("aiWrite({platform:'openai'}) prefers OpenAI but fails over to Claude when down", async () => {
  const { primitives } = harness({
    anthropic: { impl: async () => ({ text: "from-claude", model: "claude-x" }) },
    openai: {
      impl: async () => {
        const e = new Error("openai 503");
        e.retryable = true;
        throw e;
      },
    },
  });
  const r = await primitives.aiWrite({ prompt: "x", platform: "openai" });
  assert.equal(r.provider, "anthropic", "preference must not disable failover");
});

// ── pin:true is a hard pin — no failover ─────────────────────────────────────
test("aiWrite({platform:'anthropic', pin:true}) does NOT fail over", async () => {
  const { primitives } = harness({
    anthropic: {
      impl: async () => {
        const e = new Error("claude down");
        e.retryable = true;
        throw e;
      },
    },
    openai: { impl: async () => ({ text: "openai" }) },
  });
  const r = await primitives.aiWrite({ prompt: "x", platform: "anthropic", pin: true });
  assert.equal(r.ok, false);
});

// ── schema.family/label attributes spend to the parent system ────────────────
test("schema.family attributes spend to the parent system", async () => {
  const rows = [];
  const { primitives } = harness({
    anthropic: { impl: async () => ({ text: "copy", model: "claude-x", usage: { in: 10, out: 20 } }) },
    telemetry: { record: (e) => rows.push(e) },
  });
  await primitives.aiWrite({ prompt: "x", schema: { family: "blogger" } });
  const ok = rows.find((r) => r.status === "ok");
  assert.equal(ok.label, "blogger");
  assert.equal(ok.taskId, "ai.write");
});

// ── aiSpeak: the (newly added) tts modality verb routes to OpenAI ────────────
test("aiSpeak({text}) routes to ai.tts on OpenAI and forwards the text", async () => {
  const { primitives, spies } = harness({
    openai: { impl: async (kind, req) => ({ audio: Buffer.from("mp3"), model: "gpt-4o-mini-tts" }) },
  });
  const r = await primitives.aiSpeak({ text: "Hello, this is your coach." });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  assert.equal(spies.openai.calls[0].kind, "tts");
  assert.equal(spies.openai.calls[0].request.input, "Hello, this is your coach.");
});

// ── aiTranscribe: audio modality ─────────────────────────────────────────────
test("aiTranscribe({audio}) routes to OpenAI and forwards the file", async () => {
  const { primitives, spies } = harness({
    openai: { impl: async () => ({ json: { text: "heard it" }, model: "whisper" }) },
  });
  const r = await primitives.aiTranscribe({ audio: Buffer.from("fake-pcm") });
  assert.equal(r.provider, "openai");
  assert.equal(r.result.text, "heard it");
  assert.ok(spies.openai.calls[0].request.file);
});

// ── schema.cache wires Anthropic's system into a cacheable block (real adapter)
test("schema.cache makes the Anthropic system a cacheable ephemeral block", async () => {
  const captured = {};
  const fakeAnthropicClient = {
    createMessage: async (args) => {
      captured.system = args.system;
      return { model: "claude-x", content: [{ type: "text", text: "ok" }] };
    },
    extractTextBlocks: (r) => r.content.map((b) => b.text).join(""),
    extractToolUse: () => null,
  };
  const providers = createAiProviders({ anthropic: fakeAnthropicClient });
  const runner = createAiTaskRunner({ providers, registry, env: {} });
  const { aiWrite } = createAiPrimitives({ runner });
  await aiWrite({
    prompt: { system: "STABLE PREFIX", user: "hi" },
    schema: { cache: { anthropic: { ephemeralSystem: true } } },
  });
  assert.ok(Array.isArray(captured.system), "system should be a cacheable block array");
  assert.equal(captured.system[0].cache_control.type, "ephemeral");
  assert.equal(captured.system[0].text, "STABLE PREFIX");
});

// ── aliases share the machine ─────────────────────────────────────────────────
test("aiReact and aiGrade are aliases of aiWrite / aiScore", async () => {
  const { primitives } = harness({
    anthropic: { impl: async () => ({ text: "react!" }) },
    openai: { impl: async () => ({ json: { overallScore: 88 }, model: "gpt-x" }) },
  });
  const react = await primitives.aiReact({ prompt: "quick reaction" });
  assert.equal(react.taskId, "ai.write");
  const grade = await primitives.aiGrade({ prompt: "grade this", schema: { output: { type: "object" } } });
  assert.equal(grade.taskId, "ai.score");
  assert.equal(grade.result.overallScore, 88);
});
