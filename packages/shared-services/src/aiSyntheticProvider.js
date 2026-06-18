"use strict";

// Synthetic AI provider — a drop-in adapter that returns SCHEMA-SHAPED canned
// results instead of calling a real model. Lets us boot the bus locally, hit the
// real HTTP/runner/validation path, and push realistic-shaped data to a client
// with ZERO spend and no API keys. NOT for production serving (model = synthetic).
//
// For json/classify it fabricates a contract-valid object from the task's schema
// (so the runner's validator passes and the client sees the real field shape).
// For compose it returns plausible text; modality kinds return stub payloads.

function unwrap(schema) {
  return schema && schema.input_schema ? schema.input_schema : schema;
}

// Build a valid value for a JSON-schema node (enum→first, types→samples, arrays→one item).
function fabricateFromSchema(schema, depth = 0) {
  const sc = unwrap(schema);
  if (!sc || depth > 5) return {};
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0];
  const type = Array.isArray(sc.type) ? sc.type.find((t) => t !== "null") || "string" : sc.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const [k, def] of Object.entries(sc.properties || {})) out[k] = fabricateFromSchema(def, depth + 1);
      return out;
    }
    case "array":
      return [fabricateFromSchema(sc.items || { type: "string" }, depth + 1)];
    case "number":
    case "integer":
      return 7;
    case "boolean":
      return true;
    case "null":
      return null;
    case "string":
    default:
      return "synthetic";
  }
}

// A short plausible compose body so prose tasks "look like something" on a client.
function syntheticCompose(request = {}) {
  const sys = String(request.system || "").toLowerCase();
  if (sys.includes("pitch") || sys.includes("resolution")) {
    return "Based on the dossier, lead with the levy timeline and anchor the fee against the consequence.\n```verdict\n{\"class\":\"DEVELOP\"}\n```";
  }
  if (sys.includes("strateg")) {
    return "## Read\n- Scared, behind on filing.\n## Angle\n- Lead with relief from enforcement.";
  }
  return "Synthetic response — the bus, runner, validation and transport all ran; only the model was faked.";
}

function createSyntheticAdapter({ id = "synthetic" } = {}) {
  return {
    id,
    supports: () => true,
    async run(kind, request = {}, _opts = {}) {
      if (kind === "compose") {
        return { text: syntheticCompose(request), model: `${id}:compose`, usage: { synthetic: true }, provider: id };
      }
      if (kind === "json" || kind === "classify") {
        const schema = request.schema || (request.tool && request.tool.schema);
        return { json: fabricateFromSchema(schema), model: `${id}:${kind}`, usage: { synthetic: true }, provider: id };
      }
      if (kind === "transcribe") {
        return { json: { text: "Synthetic transcript: prospect says they owe the IRS about thirty thousand." }, model: `${id}:stt`, provider: id };
      }
      if (kind === "image") {
        return { json: { data: [{ b64_json: "", synthetic: true }] }, model: `${id}:image`, provider: id };
      }
      if (kind === "tts") {
        return { audio: Buffer.from("synthetic-audio"), model: `${id}:tts`, provider: id };
      }
      const err = new Error(`synthetic: unsupported kind "${kind}"`);
      err.unsupported = true;
      throw err;
    },
  };
}

// A providers map (both slots synthetic) for a runner that never spends.
function createSyntheticProviders() {
  return {
    anthropic: createSyntheticAdapter({ id: "anthropic-synthetic" }),
    openai: createSyntheticAdapter({ id: "openai-synthetic" }),
  };
}

module.exports = { createSyntheticAdapter, createSyntheticProviders, fabricateFromSchema };
