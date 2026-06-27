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

// The harness drives the REAL runner, and now uses the REAL (canonical) validator
// too — so the contract tests judge "right shape out" with the exact validator the
// live bus uses, closing the tests-validate-differently-than-production gap.
const { createAiTaskRunner, validateAgainstSchema } = require("../../packages/shared-services/src/aiTaskRunner");
const sandbox = require("../../packages/shared-services/src/aiSandbox");

// Sandbox→runnable-task conversion is now the PRODUCTION conversion, imported —
// the harness keeps no parallel copy (no placeholder model, no separate failover
// ladder, no separate request shaping that could silently diverge from the live
// bus). sandboxRegistry's own isEnabled:()=>true keeps every task on for tests
// regardless of the production enabledDefault:false; the spy adapters ignore the
// resolved model, so the real default models are harmless here.
const { toRegistryTask } = require("../../packages/shared-services/src/aiBusRegistry");

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

module.exports = { buildSandboxRunner, sandboxRegistry, toRegistryTask, validateAgainstSchema };
