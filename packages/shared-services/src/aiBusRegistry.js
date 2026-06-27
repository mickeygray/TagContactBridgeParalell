"use strict";

// Production sandbox-backed registry. Builds runnable registry tasks from the
// sandbox descriptors (real prompt + schema + cache + plumbing) and merges them
// with the ai.* primitive verbs. This is what the live bus + the local synthetic
// bus run, and it is the SAME conversion the test harness uses (the harness
// imports toRegistryTask/validateAgainstSchema from here) — so the contract
// tests now verify the production registry, not a test-only stand-in.
//
// Design note (per the audit guide): NAMED tasks are the production interface;
// ai.* primitives are a dev/one-off surface and are default-off here.

const baseRegistry = require("./aiTaskRegistry");
const sandbox = require("./aiSandbox");
// ONE schema validator across the bus. Import the runner's (stricter — rejects
// arrays-as-objects, handles null / string / multi-type) instead of keeping a
// weaker local copy. A malformed answer is now judged the SAME way on the live
// bus and in the failover path, so "right shape out" means one thing everywhere.
// (No require cycle: aiTaskRunner depends on aiTaskRegistry, not on this file.)
const { validateAgainstSchema } = require("./aiTaskRunner");

const REASONING = new Set(["compose", "json", "classify"]);
const MODALITY = new Set(["transcribe", "image", "tts"]);

function unwrap(schema) {
  return schema && schema.input_schema ? schema.input_schema : schema;
}

const otherProvider = (p) => (p === "anthropic" ? "openai" : "anthropic");

// Real default models, by provider + kind, used when a descriptor doesn't
// declare one — either because it has no plumbing entry (primary) or for the
// OTHER provider in a reasoning task's failover ladder. Bidirectional failover
// ("accepts either provider") only works if BOTH sides resolve a real id. This
// must NEVER be a placeholder ("model" / "<provider>-model") — a bogus id makes
// the call die at adapter.run (regression: tests/ai-bus/registryFailover.test.js).
// A descriptor overrides per provider via plumbing.failoverModels / modelDefault.
const DEFAULT_MODEL = {
  anthropic: { compose: "claude-sonnet-4-6", json: "claude-sonnet-4-6", classify: "claude-sonnet-4-6" },
  openai: {
    compose: "gpt-5.4-mini", json: "gpt-5.4-mini", classify: "gpt-5.4-mini",
    transcribe: "gpt-4o-mini-transcribe", image: "gpt-image-1", tts: "gpt-4o-mini-tts",
  },
};
function defaultModelFor(provider, kind) {
  const byKind = DEFAULT_MODEL[provider] || {};
  return byKind[kind] || byKind.json || null;
}
function failoverLadder(t, p, kind) {
  const declared = t.plumbing && t.plumbing.failoverModels && t.plumbing.failoverModels[p];
  if (declared) return Array.isArray(declared) ? declared.slice() : [declared];
  const def = defaultModelFor(p, kind);
  return def ? [def] : [];
}

function normalizeKind(kind) {
  if (kind === "compose+fence") return "compose";
  if (kind === "json+web_search") return "json";
  return kind;
}

function buildRequestFor(t, payload = {}) {
  const base = {
    cache: t.cache || undefined,
    timeoutMs: t.plumbing && t.plumbing.timeoutMs,
    maxTokens: t.plumbing && (t.plumbing.maxTokens || t.plumbing.maxOutputTokens),
    // Carry a declared temperature (e.g. classify temperature:0) explicitly. The
    // Anthropic client omits it for models that reject sampling params (Opus 4.7+).
    temperature: t.plumbing ? t.plumbing.temperature : undefined,
  };
  if (t.kind === "transcribe") return { ...base, file: payload.file ?? payload.audio };
  if (t.kind === "image") return { ...base, prompt: payload.prompt ?? payload.input };
  if (t.kind === "tts") return { ...base, input: payload.text ?? payload.input };
  const req = { ...base, system: t.system };
  if (t.userBuilder) {
    req.user = t.userBuilder({
      domain: payload.domain,
      caseId: payload.caseId,
      activitiesText: sandbox.rules.formatActivities(payload.activities || []),
    });
  } else {
    req.user = payload.input ?? payload.user ?? JSON.stringify(payload);
  }
  const nk = normalizeKind(t.kind);
  if (nk === "json" || nk === "classify") {
    const sc = unwrap(t.schema);
    req.schema = sc;
    req.tool = { name: t.tool || "result", schema: sc || { type: "object" } };
  }
  return req;
}

// A sandbox task is "ready" to run when it has a prompt (reasoning) or is a
// modality task. promptTodo stubs (system:null + reasoning) are NOT included.
function isReady(t) {
  const nk = normalizeKind(t.kind);
  if (MODALITY.has(nk)) return true;
  return Boolean(t.system) || Boolean(t.userBuilder);
}

function toRegistryTask(t) {
  const kind = normalizeKind(t.kind);
  const provider = t.provider;
  const providerOrder = REASONING.has(kind) ? [provider, otherProvider(provider)] : [provider];
  const model = (t.plumbing && t.plumbing.modelDefault) || defaultModelFor(provider, kind);
  const models = {};
  for (const p of providerOrder) models[p] = p === provider ? (model ? [model] : []) : failoverLadder(t, p, kind);
  const structured = kind === "json" || kind === "classify";
  return {
    id: t.id,
    kind,
    family: t.id.split(".")[0],
    providerOrder,
    models,
    // Only structured kinds get an output contract; a compose+fence task's schema
    // is for the embedded fence (parsed caller-side), not the top-level output.
    contract: t.schema && structured ? t.id : null,
    failClosed: t.failClosed !== undefined ? t.failClosed : null,
    cache: t.cache || null,
    enabledEnv: `AI_TASK_${baseRegistry.envKey(t.id)}_ENABLED`,
    // Named production tasks are OFF by default — flip explicitly per task.
    enabledDefault: false,
    buildRequest: (payload) => buildRequestFor(t, payload),
    _schema: t.schema,
    source: t.source,
  };
}

// The full bus registry: ai.* primitives (dev surface) + sandbox-backed named
// tasks (production interface).
function buildBusRegistry() {
  const tasks = {};
  const validators = {};

  // 1. ai.* primitive verbs (a DEV surface). Default them OFF in production —
  // the audit guide flags default-on primitives as a spend leak. Named tasks are
  // the production interface; the local synthetic bus re-enables all explicitly.
  for (const t of baseRegistry.listTasks()) {
    if (t.family === "primitive") tasks[t.id] = { ...t, enabledDefault: false };
  }
  // 2. sandbox-backed named tasks (ready ones only).
  for (const st of sandbox.listSandboxTasks()) {
    if (!isReady(st)) continue;
    const rt = toRegistryTask(st);
    if (tasks[rt.id]) {
      throw new Error(`aiBusRegistry: task id "${rt.id}" collides between the sandbox and the primitive surface`);
    }
    tasks[rt.id] = rt;
    if (rt.contract) validators[rt.id] = (result) => validateAgainstSchema(result, rt._schema);
  }

  const registry = {
    envKey: baseRegistry.envKey,
    getTask: (id) => tasks[id] || null,
    listTasks: () => Object.values(tasks),
    getValidator: (name) => validators[name] || baseRegistry.getValidator(name),
    isEnabled: (task, env = process.env) => baseRegistry.isEnabled(task, env),
    describeTask: (task, env = process.env) => ({
      id: task.id,
      kind: task.kind,
      family: task.family || null,
      providerOrder: task.providerOrder,
      models: task.models,
      contract: task.contract || null,
      caps: task.caps || null,
      enabled: baseRegistry.isEnabled(task, env),
      source: task.source || null,
    }),
  };
  assertBusRegistryIntegrity(registry);
  return registry;
}

// Boot-time invariants — fail LOUD at registry build rather than silently shipping
// a drifted task surface (mirrors aiTaskRegistry.assertRegistryIntegrity). Every
// task must declare a fail-closed policy, every contract must resolve to a real
// validator, and every provider in a task's order must have a non-empty model
// ladder (the dead-ladder bug that let a stale grader ladder silently no-op).
function assertBusRegistryIntegrity(registry) {
  for (const t of registry.listTasks()) {
    if (!("failClosed" in t)) {
      throw new Error(`aiBusRegistry: task "${t.id}" declares no failClosed policy (use null to opt out explicitly)`);
    }
    if (t.contract && typeof registry.getValidator(t.contract) !== "function") {
      throw new Error(`aiBusRegistry: task "${t.id}" contract "${t.contract}" resolves to no validator`);
    }
    for (const p of t.providerOrder || []) {
      const models = (t.models && t.models[p]) || [];
      if (!models.length) {
        throw new Error(`aiBusRegistry: task "${t.id}" provider "${p}" has an empty model ladder (dead failover)`);
      }
    }
  }
  return registry;
}

module.exports = {
  buildBusRegistry,
  assertBusRegistryIntegrity,
  toRegistryTask,
  validateAgainstSchema,
  normalizeKind,
  isReady,
};
