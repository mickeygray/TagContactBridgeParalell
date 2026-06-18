"use strict";

// Test harness for the AI bus VERIFICATION LAYER. NOT a test file (no .test).
//
// It turns a sandbox descriptor (real prompt + schema + cache + plumbing) into a
// runnable registry task + a schema-derived validator, then drives it through the
// REAL aiTaskRunner with spy provider adapters. So the contract tests assert, for
// every task, the shape that goes IN (the request the adapter receives) and the
// shape that comes OUT (the validated envelope) — entirely on local, no network.
//
// When the bus is actually wired, this conversion is what the production registry
// will do; the tests stay the spec.

const { createAiTaskRunner } = require("../../packages/shared-services/src/aiTaskRunner");
const sandbox = require("../../packages/shared-services/src/aiSandbox");

const REASONING = new Set(["compose", "json", "classify"]);

function unwrapSchema(schema) {
  if (!schema) return null;
  return schema.input_schema ? schema.input_schema : schema;
}

// Generic "right shape out" check: required keys present, enum membership, basic
// primitive types. Pragmatic, not a full JSON-schema validator.
function validateAgainstSchema(value, schema) {
  const sc = unwrapSchema(schema);
  if (!sc) return { ok: true };
  if (sc.type === "object" && (value === null || typeof value !== "object")) return { ok: false, reason: "not-object" };
  for (const key of sc.required || []) {
    if (value[key] === undefined) return { ok: false, reason: `missing:${key}` };
  }
  for (const [k, def] of Object.entries(sc.properties || {})) {
    if (value[k] === undefined || value[k] === null) continue;
    if (def.enum && !def.enum.includes(value[k])) return { ok: false, reason: `enum:${k}` };
    if (def.type === "number" && typeof value[k] !== "number") return { ok: false, reason: `type:${k}` };
    if (def.type === "boolean" && typeof value[k] !== "boolean") return { ok: false, reason: `type:${k}` };
  }
  return { ok: true };
}

const other = (p) => (p === "anthropic" ? "openai" : "anthropic");

// Build the provider-neutral request from a sandbox descriptor + a payload —
// mirrors what the production buildRequest will do.
function buildRequest(t, payload = {}) {
  const base = { cache: t.cache || undefined, timeoutMs: t.plumbing && t.plumbing.timeoutMs, maxTokens: t.plumbing && (t.plumbing.maxTokens || t.plumbing.maxOutputTokens) };
  if (t.kind === "transcribe") return { ...base, file: payload.file ?? payload.audio };
  if (t.kind === "image") return { ...base, prompt: payload.prompt ?? payload.input };
  if (t.kind === "tts") return { ...base, input: payload.text ?? payload.input };
  const req = { ...base, system: t.system };
  if (t.userBuilder) {
    req.user = t.userBuilder({ domain: payload.domain, caseId: payload.caseId, activitiesText: sandbox.rules.formatActivities(payload.activities || []) });
  } else {
    req.user = payload.input ?? payload.user ?? JSON.stringify(payload);
  }
  if (t.kind === "json" || t.kind === "classify") {
    const sc = unwrapSchema(t.schema);
    req.schema = sc;
    req.tool = { name: t.tool || "result", schema: sc || { type: "object" } };
  }
  return req;
}

function normalizeKind(kind) {
  return kind === "compose+fence" || kind === "json+web_search" ? (kind.startsWith("compose") ? "compose" : "json") : kind;
}

// Convert one sandbox task into a registry-shaped task.
function toRegistryTask(t) {
  const kind = normalizeKind(t.kind);
  const provider = t.provider;
  const providerOrder = REASONING.has(kind) ? [provider, other(provider)] : [provider];
  const model = (t.plumbing && t.plumbing.modelDefault) || "model";
  // Failover provider needs a REAL id (mirrors aiBusRegistry.failoverLadder) so
  // cross-provider failover resolves a usable model, not a placeholder.
  const FAILOVER = { anthropic: "claude-sonnet-4-6", openai: "gpt-5.4-mini" };
  const models = {};
  for (const p of providerOrder) {
    const declared = t.plumbing && t.plumbing.failoverModels && t.plumbing.failoverModels[p];
    models[p] = p === provider ? [model] : declared ? (Array.isArray(declared) ? declared.slice() : [declared]) : [FAILOVER[p]].filter(Boolean);
  }
  return {
    id: t.id,
    kind,
    family: t.id.split(".")[0],
    providerOrder,
    models,
    // Only STRUCTURED kinds get an output contract. A compose+fence task (e.g.
    // resolution.pitch) carries a schema for its embedded fence, parsed caller-
    // side — it is NOT the top-level output contract.
    contract: t.schema && (kind === "json" || kind === "classify") ? t.id : null,
    failClosed: t.failClosed !== undefined ? t.failClosed : null,
    enabledDefault: true,
    buildRequest: (payload) => buildRequest(t, payload),
    _schema: t.schema,
  };
}

// A registry over the sandbox tasks, with schema-derived validators.
function sandboxRegistry() {
  const tasks = {};
  const validators = {};
  for (const t of sandbox.listSandboxTasks()) {
    const rt = toRegistryTask(t);
    tasks[rt.id] = rt;
    if (rt.contract) validators[rt.id] = (result) => validateAgainstSchema(result, rt._schema);
  }
  return {
    envKey: (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    getTask: (id) => tasks[id] || null,
    getValidator: (name) => validators[name] || null,
    isEnabled: () => true,
  };
}

function spyAdapter(id, impl, supports = () => true) {
  const calls = [];
  return {
    calls,
    adapter: {
      id,
      supports,
      run: async (kind, request, opts) => {
        calls.push({ kind, request, model: opts.model });
        return impl(kind, request, opts);
      },
    },
  };
}

// Build a runner over the sandbox registry. `result(provider, kind, request)`
// returns the fake adapter output; defaults to a schema-shaped echo when omitted.
function buildSandboxRunner({ result, anthropicSupports, openaiSupports } = {}) {
  const reg = sandboxRegistry();
  const impl = (provider) => async (kind, request, opts) => {
    const out = result ? result(provider, kind, request, opts) : undefined;
    if (out !== undefined) return out;
    // default: nothing useful — forces the test to supply results
    return { model: opts.model, provider };
  };
  const a = spyAdapter("anthropic", impl("anthropic"), anthropicSupports);
  const o = spyAdapter("openai", impl("openai"), openaiSupports);
  const providers = { anthropic: a.adapter, openai: o.adapter };
  const runner = createAiTaskRunner({ providers, registry: reg, env: {} });
  return { runner, spies: { anthropic: a, openai: o }, registry: reg };
}

module.exports = { buildSandboxRunner, sandboxRegistry, toRegistryTask, buildRequest, validateAgainstSchema, normalizeKind };
