"use strict";

// In-process, SYNCHRONOUS coach model-override cache for the ai-bus (7000).
//
// Mirrors the proven setComposerTier/getComposerTier no-restart pattern
// (server.js ~1021/1093) but for the MODEL id instead of the effort/thinking
// "tier". The live coach reads resolveCoachModel() on the per-turn path, so it
// MUST stay synchronous: a module-var read only — never an await / Mongo round
// trip. Any I/O on the turn path would add latency to the live coach line.
//
// The cache is fed by applyCoachPolicy() from two places, both OFF the turn path:
//   (a) the secret-gated POST /api/ai/policy/invalidate push (5001 -> 7000), and
//   (b) the 7000 boot cold-load of the 5001-owned AiPolicy Mongo doc.
// 5001 owns persistence; 7000 owns execution. The module var is never the source
// of truth — it is re-seeded from Mongo on a restart, so an override survives the
// one floor-allowed 7000 restart.
//
// DEFAULT-OFF: with no policy row (or enabled:false), resolveCoachModel() returns
// the caller's env-default, byte-identical to today.
//
// READ-TIME CLAMP: an override that is empty, unknown, or cross-provider for the
// component falls back to the env-default rather than reaching the provider with
// a bad id and failing EVERY turn (mirrors getComposerTier falling back to a known
// tier on an invalid value). The streaming dialog composer especially needs this:
// a typo must cost nothing, not drop the coach line on every turn.

// Per-component model allow-sets. Lists are provider-correct, so membership also
// enforces same-provider (you can't put an OpenAI id on the Anthropic tick).
// dialogComposer carries two sub-roles (tick = live Sonnet turn, ask = Opus pull).
// Declared in code on purpose: one reviewable place, the admin UI renders only
// these choices. Extend deliberately; every id here must be a real model.
const COACH_ALLOW = Object.freeze({
  "liveCoach.rollingDigest": { openai: ["gpt-5.4-mini", "gpt-5.4"] },
  "liveCoach.callGrader": { openai: ["gpt-5.4", "gpt-5.4-mini"] },
  "liveCoach.contextJudge": { openai: ["gpt-5.4-mini", "gpt-5.4"] },
  "liveCoach.callStrategy": { anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"] },
  "liveCoach.dialogComposer": {
    tick: { anthropic: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"] },
    ask: { anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"] },
  },
});

function allowListFor(key, role) {
  const entry = COACH_ALLOW[key];
  if (!entry) return null; // unknown component — no declared allow-set
  const scope = role && entry[role] ? entry[role] : entry;
  const out = [];
  for (const v of Object.values(scope)) if (Array.isArray(v)) out.push(...v);
  return out;
}

// The live cache. components[key] = { enabled?:bool, model?:string, roles?:{tick,ask} }.
let policy = { rev: 0, components: {} };

// SYNCHRONOUS per-turn read. key = componentKey, role = optional sub-role
// (tick/ask for dialogComposer), envDefault = the factory's boot env-ladder value
// returned whenever no valid override applies.
function resolveCoachModel(key, role, envDefault) {
  const comp = policy.components && policy.components[key];
  if (!comp || comp.enabled === false) return envDefault;
  let candidate = null;
  if (role && comp.roles && comp.roles[role]) candidate = comp.roles[role];
  else if (comp.model) candidate = comp.model;
  candidate = candidate ? String(candidate).trim() : "";
  if (!candidate) return envDefault;
  const allow = allowListFor(key, role);
  if (allow && !allow.includes(candidate)) return envDefault; // read-time clamp
  return candidate;
}

// Replace the cache wholesale (idempotent). Fed by invalidate-push + boot cold
// load — never on the turn path.
function applyCoachPolicy(doc = {}) {
  const components = doc && typeof doc.components === "object" && doc.components ? doc.components : {};
  policy = { rev: Number(doc.rev) || 0, components };
  return getCoachPolicyState();
}

function getCoachPolicyState() {
  return { rev: policy.rev, components: { ...policy.components } };
}

// Honest-coverage: report each component's sub-roles + allow-sets so the admin
// surface renders only legal choices and never implies control of an unknown
// component. (Live constructability — e.g. the composer being boot-disabled — is
// added by the server, which knows which factories are null.)
function describeCoachComponents() {
  return Object.entries(COACH_ALLOW).map(([key, entry]) => {
    const roleKeys = Object.keys(entry).filter((r) => entry[r] && typeof entry[r] === "object" && !Array.isArray(entry[r]));
    const hasRoles = roleKeys.length > 0;
    return {
      key,
      roles: hasRoles ? roleKeys : null,
      allow: hasRoles
        ? Object.fromEntries(roleKeys.map((r) => [r, allowListFor(key, r)]))
        : { default: allowListFor(key, null) },
    };
  });
}

function resetCoachPolicy() {
  policy = { rev: 0, components: {} };
}

module.exports = {
  COACH_ALLOW,
  allowListFor,
  resolveCoachModel,
  applyCoachPolicy,
  getCoachPolicyState,
  describeCoachComponents,
  resetCoachPolicy,
};
