"use strict";

// AI task runner — the heart of the unified bus.
//
// Given a taskId + payload, it: resolves the task, builds a provider-neutral
// request, then walks the provider/model chain. It fails over to the next
// provider when one errors, times out, is unsupported, or returns output that
// fails the task contract — in EITHER direction (Claude->OpenAI or
// OpenAI->Claude), because the provider order is just config. If every option
// is exhausted it returns the task's fail-closed shape.
//
// Provider selection precedence (most specific wins):
//   1. options.forceProvider                              (one-off pin)
//   2. env AI_TASK_<ID>_PROVIDER         (single)         (ops pin: "grader on claude")
//   3. env AI_TASK_<ID>_PROVIDER_ORDER   (csv, reorder)
//   4. task.providerOrder                (registry default)
// Model selection precedence per provider:
//   1. options.forceModel
//   2. env AI_TASK_<ID>_<PROVIDER>_MODEL (csv ladder)
//   3. options.qualityMode -> task.quality[mode], prepended to the ladder
//   4. task.models[provider]
//
// Injectable deps (providers, registry, telemetry, env, now) so it unit-tests
// with fakes and no network.

const defaultRegistry = require("./aiTaskRegistry");

function csv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function classifyError(err) {
  if (err && err.unsupported) return "unsupported";
  if (err && err.retryable === false) return "fatal";
  return "error";
}

function unwrapSchema(schema) {
  return schema && schema.input_schema ? schema.input_schema : schema;
}

function declaredTypes(definition) {
  const declared = definition && definition.type;
  if (!declared) return [];
  return Array.isArray(declared) ? declared : [declared];
}

function valueMatchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function validateAgainstSchema(value, schema) {
  const sc = unwrapSchema(schema);
  if (!sc) return { ok: true };
  if (sc.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return { ok: false, reason: "not-object" };
  }

  for (const key of sc.required || []) {
    if (value == null || value[key] === undefined) return { ok: false, reason: `missing:${key}` };
  }

  for (const [key, definition] of Object.entries(sc.properties || {})) {
    const v = value && value[key];
    if (v === undefined || v === null) continue;
    if (definition.enum && !definition.enum.includes(v)) return { ok: false, reason: `enum:${key}` };
    const types = declaredTypes(definition);
    if (types.length && !types.some((type) => valueMatchesType(v, type))) {
      return { ok: false, reason: `type:${key}` };
    }
  }
  return { ok: true };
}

function validatorForRequestSchema(schema) {
  const sc = unwrapSchema(schema);
  if (!sc) return null;
  return (value) => validateAgainstSchema(value, sc);
}

function createAiTaskRunner({
  providers = {},
  registry = defaultRegistry,
  telemetry = null,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  function recordRaw(entry) {
    try {
      telemetry?.record?.(entry);
    } catch {
      /* telemetry must never break a task */
    }
  }

  function resolveModels(task, provider, options) {
    if (options.forceModel) return [options.forceModel];
    // A per-call preferred model applies only to the preferred provider; the
    // failover provider keeps its own ladder (a gpt id can't run on Claude).
    if (options.preferProvider === provider && options.preferModel) {
      return uniq([options.preferModel, ...((task.models && task.models[provider]) || [])]);
    }
    const envModels = env[`AI_TASK_${registry.envKey(task.id)}_${provider.toUpperCase()}_MODEL`];
    if (envModels) return csv(envModels);
    const base = (task.models && task.models[provider]) || [];
    const tierModel = options.qualityMode && task.quality ? task.quality[options.qualityMode] : undefined;
    return uniq(tierModel ? [tierModel, ...base] : base.slice());
  }

  function resolveOrder(task, options) {
    let order = Array.isArray(task.providerOrder) ? task.providerOrder.slice() : Object.keys(providers);
    const envOrder = env[`AI_TASK_${registry.envKey(task.id)}_PROVIDER_ORDER`];
    if (envOrder) order = csv(envOrder);
    // preferProvider = soft preference: try it first but KEEP the others as
    // failover (resilience preserved). forceProvider/env pin = hard, no failover.
    if (options.preferProvider) order = uniq([String(options.preferProvider).trim(), ...order]);
    const envPin = env[`AI_TASK_${registry.envKey(task.id)}_PROVIDER`];
    if (envPin) order = [String(envPin).trim()];
    if (options.forceProvider) order = [String(options.forceProvider).trim()];
    return order.map((provider) => ({ provider, models: resolveModels(task, provider, options) }));
  }

  function failClosed(task, taskId, code, attempts) {
    return {
      ok: false,
      taskId,
      code,
      // Preserve the contract author's intent: an explicit `failClosed: null`
      // (no safe shape) is distinct from a task that never declared one.
      safeFallback: task && "failClosed" in task ? task.failClosed : null,
      attempts: attempts || [],
    };
  }

  async function runAiTask(taskId, payload = {}, options = {}) {
    // Every telemetry row carries the caller's label (e.g. "blogger.write",
    // "coach.react") so spend attributes to the parent system, not just the
    // task id. Primitives lean on this for per-system rollups.
    const record = (entry) => recordRaw({ label: options.label || null, ...entry });
    const task = registry.getTask(taskId);
    if (!task) {
      record({ taskId, status: "unknown_task" });
      return { ok: false, taskId, code: "unknown_task", safeFallback: null, attempts: [] };
    }

    if (!options.ignoreEnabled && !registry.isEnabled(task, env)) {
      record({ taskId, status: "disabled" });
      return failClosed(task, taskId, "disabled", []);
    }

    // buildRequest can throw on bad payload — fail closed rather than crash the
    // caller (a thrown task is worse than a safe fallback on the floor).
    let request;
    try {
      request = task.buildRequest ? task.buildRequest(payload, options) : payload;
    } catch (err) {
      record({ taskId, family: task.family, status: "buildRequest_error", error: err.message });
      return failClosed(task, taskId, `buildRequest_error:${err.message}`, []);
    }
    // A caller (or primitive) may pass its own validator; otherwise use the
    // task's registered contract. This lets ad-hoc primitive calls enforce a
    // shape without registering a named contract.
    const validate = options.validate || registry.getValidator(task.contract) || validatorForRequestSchema(request && request.schema);
    // The descriptor's kind can be overridden per call — e.g. aiWrite with a
    // schema.output becomes structured generation (json) instead of compose.
    const kind = options.kind || task.kind;
    const order = resolveOrder(task, options);
    const attempts = [];
    let lastError = null;

    // No candidate providers at all (misconfigured order, or an empty providers
    // map) — fail closed with a clear reason, not a vague all-providers-failed.
    if (!order.length) {
      record({ taskId, family: task.family, status: "no_providers" });
      return failClosed(task, taskId, "no_providers_configured", []);
    }

    for (const step of order) {
      // Caller gave up (request closed / timed out): don't start another paid
      // provider attempt. Bounds wasted spend to whatever is already in flight.
      if (options.signal && options.signal.aborted) {
        record({ taskId, family: task.family, status: "caller_aborted" });
        return failClosed(task, taskId, "caller_aborted", attempts);
      }
      const adapter = providers[step.provider];
      // Distinguish a provider that isn't wired in this process from one that
      // can't do this kind — the two need very different fixes.
      if (!adapter || typeof adapter.run !== "function") {
        attempts.push({ provider: step.provider, status: "skipped", reason: "provider-not-configured" });
        continue;
      }
      if (!adapter.supports(kind)) {
        attempts.push({ provider: step.provider, status: "skipped", reason: `unsupported-kind:${kind}` });
        continue;
      }
      const models = step.models.length ? step.models : [undefined];
      for (const model of models) {
        if (options.dryRun) {
          return { ok: true, taskId, dryRun: true, provider: step.provider, model: model || null, request };
        }
        const startedAt = now();
        try {
          const out = await adapter.run(kind, request, { model });
          const result =
            out.json !== undefined ? out.json : out.text !== undefined ? out.text : out.audio;
          // An adapter that returned nothing usable must NOT ship as ok:true with
          // an undefined result — that would bypass the contract. Treat it as a
          // retryable miss so the runner fails over, then fails closed.
          if (result === undefined) {
            lastError = new Error("adapter_empty_result");
            attempts.push({ provider: step.provider, model: out.model || model || null, status: "empty_result" });
            record({
              taskId,
              family: task.family,
              provider: step.provider,
              model: out.model || model || null,
              status: "empty_result",
              elapsedMs: now() - startedAt,
            });
            continue;
          }
          if (validate) {
            const verdict = validate(result, payload);
            if (!verdict.ok) {
              lastError = new Error(`contract_invalid:${verdict.reason || "invalid"}`);
              attempts.push({
                provider: step.provider,
                model: out.model || model || null,
                status: "contract_fail",
                reason: verdict.reason,
              });
              record({
                taskId,
                family: task.family,
                provider: step.provider,
                model: out.model || model || null,
                status: "contract_fail",
                reason: verdict.reason,
                elapsedMs: now() - startedAt,
              });
              continue; // try next model / provider
            }
          }
          record({
            taskId,
            family: task.family,
            provider: step.provider,
            model: out.model || model || null,
            status: "ok",
            elapsedMs: now() - startedAt,
            usage: out.usage || null,
          });
          return {
            ok: true,
            taskId,
            provider: step.provider,
            model: out.model || model || null,
            usage: out.usage || null,
            result,
            attempts,
          };
        } catch (err) {
          lastError = err;
          const code = classifyError(err);
          attempts.push({ provider: step.provider, model: model || null, status: code, error: err.message });
          record({
            taskId,
            family: task.family,
            provider: step.provider,
            model: model || null,
            status: code,
            error: err.message,
            elapsedMs: now() - startedAt,
          });
          if (err.unsupported) break; // this provider can't do the kind; skip its remaining models
          // otherwise fall through to the next model, then the next provider
        }
      }
    }

    return failClosed(task, taskId, lastError ? lastError.message || "all_providers_failed" : "all_providers_failed", attempts);
  }

  return { runAiTask };
}

module.exports = { createAiTaskRunner };
