"use strict";

// AI task registry — the menu of jobs the "one brain" can do.
//
// A task is provider-NEUTRAL. It declares:
//   - kind        : compose | json | classify | transcribe | image | tts
//   - providerOrder: the CAPABLE providers, in default preference order. For
//                    reasoning kinds this is normally ["anthropic","openai"] or
//                    ["openai","anthropic"] — BOTH, because either can do it.
//                    The order is just a default; env/options can flip it, and
//                    the runner fails over to the next provider if one is down.
//   - models      : per-provider model ladder (central config; env-overridable)
//   - buildRequest: payload -> provider-neutral { system, user, schema, tool,
//                    maxTokens, temperature, timeoutMs }
//   - contract    : name of a validator; invalid output triggers failover
//   - failClosed  : the safe shape returned when every provider fails
//
// Nothing here hardwires a provider into a task's logic. Swapping the grader to
// Claude or the brain to OpenAI is a config change, not a code change.

function envKey(taskId) {
  return String(taskId).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function boolEnv(value, dflt) {
  if (value === undefined || value === null || value === "") return dflt;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// ── Contract validators ──────────────────────────────────────────────────────
// Cheap, provider-agnostic shape checks. A failed check makes the runner try the
// next provider/model, then fail closed — so a malformed answer never ships.
const ACTIVITY_STATUSES = ["allow_contact", "pause_contact", "stop_contact", "manual_review"];
const SMS_TIERS = ["hard_stop", "dnc_confirm", "soft_defer", "callback_prompt", "needs_human"];

function validateActivityReview(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "not-object" };
  if (!ACTIVITY_STATUSES.includes(result.status)) return { ok: false, reason: "bad-status" };
  return { ok: true };
}

function validateSmsClassification(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "not-object" };
  if (!SMS_TIERS.includes(result.tier)) return { ok: false, reason: "bad-tier" };
  return { ok: true };
}

function validateCallGrade(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "not-object" };
  if (typeof result.overallScore !== "number") return { ok: false, reason: "no-score" };
  return { ok: true };
}

function validateTranslation(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "not-object" };
  if (typeof result.text !== "string" || !result.text.trim()) return { ok: false, reason: "no-text" };
  return { ok: true };
}

function validateBlogDraft(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "not-object" };
  if (typeof result.id !== "string" || !result.id.trim()) return { ok: false, reason: "no-id" };
  if (typeof result.bodyHtml !== "string" || !result.bodyHtml.trim()) return { ok: false, reason: "no-body" };
  if (!result.slide || typeof result.slide !== "object") return { ok: false, reason: "no-slide" };
  return { ok: true };
}

const VALIDATORS = {
  activityReview: validateActivityReview,
  smsClassification: validateSmsClassification,
  callGrade: validateCallGrade,
  translation: validateTranslation,
  blogDraft: validateBlogDraft,
};

// ── Schemas (used as Anthropic tool input_schema / OpenAI json target) ────────
const ACTIVITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ACTIVITY_STATUSES },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    recommendedAction: { type: "string" },
    rationale: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    positiveNotes: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    riskFlags: { type: "array", items: { type: "string" } },
  },
  required: ["status", "confidence"],
};

const ACTIVITY_REVIEW_SYSTEM =
  "You review CRM case activities for future contact safety. Focus on signals like " +
  "do not call, cease and desist, attorney involvement, deceased, bankruptcy, and fraud. " +
  "Decide whether it is safe to keep contacting this case. Return only the structured result.";

function formatActivitiesForPrompt(activities = []) {
  return activities
    .slice(0, 40)
    .map((a, i) =>
      [
        `Activity ${i + 1}:`,
        `Created: ${a.CreatedDate || a.createdDate || ""}`,
        `Type: ${a.ActivityType || a.type || ""}`,
        `Subject: ${a.Subject || a.subject || ""}`,
        `Comment: ${String(a.Comment || a.comment || "").slice(0, 600)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

// ── Task table ────────────────────────────────────────────────────────────────
// activity.contactSafetyReview is fully inlined (the proof migration: small
// prompt, JSON-only, batch, portable). The high-prompt tasks are registered with
// their wiring but receive their (large, existing) system/user from the caller
// until each is fully re-housed — they are still provider-neutral and fail over.
const TASKS = {
  "activity.contactSafetyReview": {
    id: "activity.contactSafetyReview",
    kind: "json",
    family: "activity",
    providerOrder: ["anthropic", "openai"],
    models: {
      anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      openai: ["gpt-5.4-mini", "gpt-5.4"],
    },
    contract: "activityReview",
    caps: { maxOutputTokens: 1200, timeoutMs: 25000 },
    // OFF by default — turning this on routes the batch reviewer through the bus.
    enabledEnv: "AI_TASK_ACTIVITY_CONTACTSAFETYREVIEW_ENABLED",
    enabledDefault: false,
    failClosed: { status: "manual_review", confidence: "low", viaFailClosed: true },
    buildRequest(payload = {}) {
      const { domain = "", caseId = "", activities = [] } = payload;
      return {
        system: ACTIVITY_REVIEW_SYSTEM,
        user:
          `Domain: ${domain}\nCase ID: ${caseId}\nReview type: contact-safety\n` +
          `Task: Determine contact safety based on the activities below.\nActivities:\n` +
          formatActivitiesForPrompt(activities),
        schema: ACTIVITY_REVIEW_SCHEMA,
        tool: { name: "contact_safety_review", schema: ACTIVITY_REVIEW_SCHEMA },
        maxTokens: 1200,
        temperature: 0,
        timeoutMs: 25000,
      };
    },
  },

  "sms.classify": {
    id: "sms.classify",
    kind: "classify",
    family: "sms",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-opus-4-6", "claude-sonnet-4-6"], openai: ["gpt-5.4", "gpt-5.4-mini"] },
    contract: "smsClassification",
    caps: { maxOutputTokens: 900, timeoutMs: 25000 },
    enabledEnv: "AI_TASK_SMS_CLASSIFY_ENABLED",
    enabledDefault: false,
    // Compliance fail-safe: a human looks at it rather than auto-acting.
    failClosed: { tier: "needs_human", confidence: 0, viaFailClosed: true },
    buildRequest(payload = {}) {
      return {
        system: payload.system, // 475-line classifier prompt, supplied at migration
        user: payload.user,
        schema: payload.schema,
        tool: { name: "classify_sms", schema: payload.schema },
        maxTokens: 900,
        temperature: 0,
        timeoutMs: 25000,
      };
    },
  },

  "liveCoach.callGrade": {
    id: "liveCoach.callGrade",
    kind: "json",
    family: "live-coach",
    providerOrder: ["openai", "anthropic"], // default OpenAI, but Claude can grade too
    models: { openai: ["gpt-5.4"], anthropic: ["claude-sonnet-4-6", "claude-opus-4-8"] },
    contract: "callGrade",
    caps: { maxOutputTokens: 950, timeoutMs: 45000 },
    enabledEnv: "AI_TASK_LIVECOACH_CALLGRADE_ENABLED",
    enabledDefault: false,
    failClosed: null,
    buildRequest(payload = {}) {
      return {
        system: payload.system,
        user: payload.user,
        schema: payload.schema,
        maxTokens: 950,
        timeoutMs: 45000,
      };
    },
  },

  "liveCoach.translate": {
    id: "liveCoach.translate",
    kind: "json",
    family: "live-coach",
    // OpenAI-first so the high-volume per-utterance translation is cheap; Claude
    // is the automatic failover. Flip with AI_TASK_LIVECOACH_TRANSLATE_PROVIDER.
    providerOrder: ["openai", "anthropic"],
    models: { openai: ["gpt-5.4-mini"], anthropic: ["claude-haiku-4-5"] },
    contract: "translation",
    caps: { maxOutputTokens: 400, timeoutMs: 700 },
    enabledEnv: "AI_TASK_LIVECOACH_TRANSLATE_ENABLED",
    enabledDefault: false,
    failClosed: null, // caller falls back to the deterministic regex text
    buildRequest(payload = {}) {
      return {
        system: payload.system,
        user: payload.user,
        schema: payload.schema,
        tool: { name: "clean_transcript", schema: payload.schema },
        maxTokens: 400,
        temperature: 0,
        timeoutMs: 700,
      };
    },
  },

  "resolution.pitch": {
    id: "resolution.pitch",
    kind: "compose",
    family: "resolution",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"], openai: ["gpt-5.4"] },
    contract: null,
    caps: { maxOutputTokens: 8000, timeoutMs: 75000 },
    enabledEnv: "AI_TASK_RESOLUTION_PITCH_ENABLED",
    enabledDefault: false,
    failClosed: { ok: false, error: "ai-task-failed" },
    buildRequest(payload = {}) {
      return {
        system: payload.system,
        user: payload.user,
        maxTokens: 8000,
        timeoutMs: 75000,
      };
    },
  },

  "blogger.currentEvent": {
    id: "blogger.currentEvent",
    kind: "search",
    family: "blogger",
    // Agentic web_search loop (Anthropic server-side web_search → forced submit).
    // Anthropic-only today; once the `claude -p` agent adapter lands it goes
    // FIRST in the order — ["agent", "anthropic"] — making the Max agent the
    // default and the API the rollover (the v1 substrate target).
    providerOrder: ["anthropic"],
    models: { anthropic: ["claude-sonnet-4-6"] },
    contract: "blogDraft",
    caps: { maxOutputTokens: 8000, timeoutMs: 90000 },
    // The daily-runner invoking it IS the intent to run; env kill switch available.
    enabledEnv: "AI_TASK_BLOGGER_CURRENTEVENT_ENABLED",
    enabledDefault: true,
    // Caller (blogger-current-event.js) throws on !ok so the daily-runner's
    // existing static-draft fallback fires — preserve that, don't ship a shape.
    failClosed: null,
    buildRequest(payload = {}) {
      return {
        system: payload.system,
        user: payload.user,
        tools: payload.tools, // [{ type:"web_search_20250305", ... }]
        submitTool: payload.submitTool, // { name, description, schema }
        maxToolTurns: payload.maxToolTurns || 8,
        // Blog writing wants creativity; the bus client defaults temperature to 0,
        // so set Anthropic's default (1) explicitly to preserve original behavior.
        temperature: payload.temperature !== undefined ? payload.temperature : 1,
        maxTokens: 8000,
        timeoutMs: payload.timeoutMs || 90000,
      };
    },
  },

  // ── Primitives ──────────────────────────────────────────────────────────────
  // The universal verbs every parent system composes from. They carry NO
  // business prompt — the caller supplies system/input (+ schema for the
  // structured ones). A named task above is just one of these with its prompt +
  // contract + caps frozen. Default-ON (gated by usage); each has an env kill
  // switch (AI_TASK_AI_*_ENABLED=false). SPEND SAFETY: default-on is acceptable
  // ONLY because the bus route is internal-auth-gated (requireInternalAccess) —
  // an internal service calling a verb IS the intent to spend. Flip these to
  // enabledDefault:false if you want explicit per-primitive enablement before
  // exposure. The caller passes options.label for per-system spend attribution and
  // may pass options.validate to enforce a shape without a registered contract.
  "ai.read": {
    id: "ai.read",
    kind: "json",
    family: "primitive",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"], openai: ["gpt-5.4-mini", "gpt-5.4"] },
    contract: null,
    caps: { maxOutputTokens: 1500, timeoutMs: 30000 },
    enabledEnv: "AI_TASK_AI_READ_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      system: p.system,
      user: p.input ?? p.user,
      schema: p.schema,
      tool: p.schema ? { name: "read_result", schema: p.schema } : undefined,
      cache: p.cache,
      maxTokens: p.maxTokens || 1500,
      temperature: p.temperature ?? 0,
      timeoutMs: p.timeoutMs || 30000,
    }),
  },
  "ai.write": {
    id: "ai.write",
    kind: "compose",
    family: "primitive",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-sonnet-4-6", "claude-opus-4-8"], openai: ["gpt-5.4", "gpt-5.4-mini"] },
    contract: null,
    caps: { maxOutputTokens: 2000, timeoutMs: 45000 },
    enabledEnv: "AI_TASK_AI_WRITE_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      system: p.system,
      user: p.input ?? p.user,
      // When the caller hands aiWrite a schema (schema.output), the call runs as
      // structured generation (kind json) — generateProfile, blogger.write, etc.
      schema: p.schema,
      tool: p.schema ? { name: "write_result", schema: p.schema } : undefined,
      cache: p.cache,
      maxTokens: p.maxTokens || 2000,
      temperature: p.temperature,
      timeoutMs: p.timeoutMs || 45000,
    }),
  },
  "ai.judge": {
    id: "ai.judge",
    kind: "classify",
    family: "primitive",
    providerOrder: ["anthropic", "openai"],
    models: { anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"], openai: ["gpt-5.4-mini", "gpt-5.4"] },
    contract: null,
    caps: { maxOutputTokens: 600, timeoutMs: 20000 },
    enabledEnv: "AI_TASK_AI_JUDGE_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      system: p.system,
      user: p.input ?? p.user,
      schema: p.schema,
      tool: { name: "judge_result", schema: p.schema || { type: "object" } },
      cache: p.cache,
      maxTokens: p.maxTokens || 600,
      temperature: 0,
      timeoutMs: p.timeoutMs || 20000,
    }),
  },
  "ai.score": {
    id: "ai.score",
    kind: "json",
    family: "primitive",
    providerOrder: ["openai", "anthropic"],
    models: { openai: ["gpt-5.4", "gpt-5.4-mini"], anthropic: ["claude-sonnet-4-6", "claude-opus-4-8"] },
    contract: null,
    caps: { maxOutputTokens: 1200, timeoutMs: 45000 },
    enabledEnv: "AI_TASK_AI_SCORE_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      system: p.system,
      user: p.input ?? p.user,
      schema: p.schema,
      tool: p.schema ? { name: "score_result", schema: p.schema } : undefined,
      cache: p.cache,
      maxTokens: p.maxTokens || 1200,
      temperature: 0,
      timeoutMs: p.timeoutMs || 45000,
    }),
  },
  "ai.transcribe": {
    id: "ai.transcribe",
    kind: "transcribe",
    family: "primitive",
    providerOrder: ["openai"], // modality: only providers that physically can
    models: { openai: ["gpt-4o-mini-transcribe", "whisper-1"] },
    contract: null,
    caps: { timeoutMs: 120000 },
    enabledEnv: "AI_TASK_AI_TRANSCRIBE_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      file: p.file,
      fileName: p.fileName,
      responseFormat: p.responseFormat,
      language: p.language,
      timeoutMs: p.timeoutMs || 120000,
    }),
  },
  "ai.image": {
    id: "ai.image",
    kind: "image",
    family: "primitive",
    providerOrder: ["openai"],
    models: { openai: ["gpt-image-1"] },
    contract: null,
    caps: { timeoutMs: 120000 },
    enabledEnv: "AI_TASK_AI_IMAGE_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      prompt: p.prompt ?? p.input,
      size: p.size,
      quality: p.quality,
      n: p.n,
      timeoutMs: p.timeoutMs || 120000,
    }),
  },
  "ai.tts": {
    id: "ai.tts",
    kind: "tts",
    family: "primitive",
    providerOrder: ["openai"], // modality: OpenAI-capable today
    models: { openai: ["gpt-4o-mini-tts"] },
    contract: null,
    caps: { timeoutMs: 30000 },
    enabledEnv: "AI_TASK_AI_TTS_ENABLED",
    enabledDefault: true,
    failClosed: null,
    buildRequest: (p = {}) => ({
      input: p.input ?? p.prompt ?? p.text,
      voice: p.voice,
      speed: p.speed,
      format: p.format,
      timeoutMs: p.timeoutMs || 30000,
    }),
  },
};

// Boot-time guard: a task that names a contract the VALIDATORS map doesn't have
// is a typo that would silently ship UNVALIDATED model output. Fail loudly at
// load instead. Exported so tests can assert it on arbitrary task tables.
function assertRegistryIntegrity(tasks = TASKS, validators = VALIDATORS) {
  for (const task of Object.values(tasks)) {
    if (task.contract && !validators[task.contract]) {
      throw new Error(
        `aiTaskRegistry: task "${task.id}" references unknown contract "${task.contract}"`,
      );
    }
  }
}
assertRegistryIntegrity();

function getTask(taskId) {
  return TASKS[taskId] || null;
}

function listTasks() {
  return Object.values(TASKS);
}

function getValidator(contract) {
  return contract ? VALIDATORS[contract] || null : null;
}

function isEnabled(task, env = process.env) {
  if (!task) return false;
  return boolEnv(task.enabledEnv ? env[task.enabledEnv] : undefined, task.enabledDefault !== false);
}

// Read-only view for GET /api/ai/tasks — never exposes prompt bodies/secrets.
function describeTask(task, env = process.env) {
  return {
    id: task.id,
    kind: task.kind,
    family: task.family || null,
    providerOrder: task.providerOrder,
    models: task.models,
    contract: task.contract || null,
    caps: task.caps || null,
    enabled: isEnabled(task, env),
  };
}

module.exports = {
  TASKS,
  VALIDATORS,
  getTask,
  listTasks,
  getValidator,
  isEnabled,
  describeTask,
  assertRegistryIntegrity,
  envKey,
  // exported for migration reuse + tests
  ACTIVITY_REVIEW_SCHEMA,
  ACTIVITY_REVIEW_SYSTEM,
  formatActivitiesForPrompt,
};
