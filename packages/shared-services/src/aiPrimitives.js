"use strict";

// AI primitives — the universal verbs every parent system composes from.
//
// Invocation model (the three-way split):
//
//   verb({ schema, prompt, model })
//          │        │       └── what's USED   — model/platform override
//          │        └────────── what's FED    — the per-call content
//          └─────────────────── the PLUMBING  — the durable task descriptor
//
// `schema` is the descriptor (a row of docs/AI_TASK_DICTIONARY.md as data). All
// fields optional:
//   - output       : the JSON output shape. Present ⇒ structured result. (For
//                    aiWrite this also flips it to structured *generation*.)
//   - cache        : how to cache — { anthropic:{ephemeralSystem:true},
//                    openai:{promptCacheKey, retention, serviceTier} }
//   - family       : "coach" | "blog" | "scrubber" ... (spend attribution)
//   - label        : explicit telemetry label (defaults to family)
//   - validate     : (result, payload) => {ok, reason} — enforce a shape without
//                    a registered contract
//   - next         : the next step id in a pipeline (carried for the orchestrator;
//                    chaining itself is a later phase — not executed here)
//   - providerRules: per-provider knobs (reserved — defined, not yet wired)
//
// `prompt` is a string (→ user) or { system, user }. Modality verbs take the
// content directly: aiTranscribe({ audio }), aiSpeak({ text }), aiImage({ prompt }).
//
// `model` is the preferred model; `platform` ("anthropic"|"openai") is a
// PREFERENCE (tried first, the other stays as failover) with `pin:true` for a
// hard, no-failover pin. Defaults for all of the above live in the registry
// ai.* tasks (set there or via AI_TASK_AI_* env) — the call just overrides.
//
// A named task (e.g. sms.classify) is one of these verbs with its schema frozen
// and given an id, for jobs that need governance.

function toCall(args = {}) {
  const { prompt, model, platform, pin = false, schema = {}, file, audio, text, ...rest } = args;
  const s = schema && typeof schema === "object" ? schema : {};

  const payload = { ...rest };
  if (typeof prompt === "string") payload.input = prompt;
  else if (prompt && typeof prompt === "object") Object.assign(payload, prompt);
  if (text !== undefined) payload.input = text; // tts content
  const audioPart = file !== undefined ? file : audio;
  if (audioPart !== undefined) payload.file = audioPart; // transcribe content
  if (s.output !== undefined) payload.schema = s.output; // the JSON output shape
  if (s.cache !== undefined) payload.cache = s.cache; // how to cache

  const options = {};
  if (platform && pin) options.forceProvider = platform;
  else if (platform) options.preferProvider = platform;
  if (model) {
    if (platform && !pin) options.preferModel = model;
    else options.forceModel = model;
  }
  if (s.label || s.family) options.label = s.label || s.family;
  if (s.validate) options.validate = s.validate;
  if (s.next) options.next = s.next; // carried for the orchestrator (later phase)
  return { payload, options, hasOutput: s.output !== undefined };
}

// runner: a createAiTaskRunner() instance. Returns the verb functions. Each
// returns the runner envelope: { ok, provider, model, usage, result } on
// success, or { ok:false, code, safeFallback } when every option is exhausted.
function createAiPrimitives({ runner } = {}) {
  if (!runner || typeof runner.runAiTask !== "function") {
    throw new Error("createAiPrimitives requires { runner } with runAiTask()");
  }
  const make = (taskId) => (args = {}) => {
    const { payload, options } = toCall(args);
    return runner.runAiTask(taskId, payload, options);
  };

  const aiRead = make("ai.read");
  // aiWrite is text by default, but becomes structured generation when the
  // schema carries an output shape (generateProfile, blogger.write, ...).
  const aiWrite = (args = {}) => {
    const { payload, options, hasOutput } = toCall(args);
    if (hasOutput) options.kind = "json";
    return runner.runAiTask("ai.write", payload, options);
  };
  const aiJudge = make("ai.judge");
  const aiScore = make("ai.score");
  const aiTranscribe = make("ai.transcribe");
  const aiImage = make("ai.image");
  const aiSpeak = make("ai.tts");

  return {
    aiRead,
    aiWrite,
    aiJudge,
    aiScore,
    aiTranscribe,
    aiImage,
    aiSpeak,
    // Intent-named aliases — same machine, different default prompt at the call
    // site. (coach reaction/guidance, text respond = aiWrite; grade = aiScore.)
    aiReact: aiWrite,
    aiRespond: aiWrite,
    aiGuide: aiWrite,
    aiGrade: aiScore,
  };
}

module.exports = { createAiPrimitives, toCall };
