"use strict";

// The SPINE head — the navigator's primary, slow job.
//
// On a CADENCE (not every turn), a Sonnet pass reads the FULL cleaned transcript and
// reports WHAT HAS ACTUALLY BEEN ACCOMPLISHED — the objective spine of the call —
// then corrects the fast deterministic phase guess, picks the skill to prime the
// composer with, and writes a short strategic brief. This is the slow authoritative
// layer; the fast per-turn layer (Haiku reaction) is strategy, not a script.
//
// Runs OFF the live path — a small delay is fine, it's the call PATH not a nudge.
// Sonnet THINKS here (inject a runner with maxThinkingTokens:null); the composer
// never does. Pure module: builds the request + parses the result; the spawn is the
// injected runner.

const { PHASES } = require("./coachPhaseMachine");

const PHASE_IDS = PHASES.map((p) => p.id); // PHASES is [{id, order, ...}]

const SPINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accomplished", "phase", "nextObjective"],
  properties: {
    accomplished: {
      type: "array",
      items: { type: "string" },
      description: "objective events that ACTUALLY happened in the transcript (e.g. 'confirmed identity', 'captured $32k balance', 'quoted $1800 fee') — never optimistic",
    },
    phase: { type: "string", description: "the call's TRUE current phase id" },
    nextObjective: { type: "string", description: "the single next thing to accomplish" },
    suggestedSkillKey: { type: ["string", "null"], description: "objection/skill key to prime the reaction composer, or null" },
    brief: { type: "string", description: "1-2 sentence strategic brief for the reaction coach" },
  },
};

const SPINE_SYSTEM = [
  "You are the navigator for a live tax-resolution sales call (Wynn Tax).",
  "Read the FULL transcript so far and report the SPINE of the call: what has",
  "ACTUALLY been accomplished (objective events only — list nothing that did not",
  "genuinely happen in the transcript), the call's true current phase, and the",
  "single next objective.",
  "Phases: " + PHASE_IDS.join(", ") + ".",
  "Output ONLY the JSON object.",
].join(" ");

function buildSpineRequest({ transcript, phase, captured } = {}) {
  const lines = [];
  lines.push(
    "Fast-guess phase: " +
      (phase || "intro") +
      (Array.isArray(captured) && captured.length ? "; captured facts: " + captured.join(", ") : "")
  );
  lines.push("Transcript so far:");
  lines.push(String(transcript || "").trim() || "(empty)");
  lines.push("Report the spine as JSON {accomplished, phase, nextObjective, suggestedSkillKey, brief}.");
  return { system: SPINE_SYSTEM, prompt: lines.join("\n"), schema: SPINE_SCHEMA };
}

function parseSpineResult(res) {
  const out = res && (res.json || (typeof res === "object" && !res.ok ? null : res));
  if (!out || typeof out !== "object") return null;
  return {
    accomplished: Array.isArray(out.accomplished) ? out.accomplished.map(String) : [],
    phase: PHASE_IDS.includes(out.phase) ? out.phase : null, // null = keep the fast-guess phase
    nextObjective: String(out.nextObjective || ""),
    suggestedSkillKey: typeof out.suggestedSkillKey === "string" && out.suggestedSkillKey ? out.suggestedSkillKey : null,
    brief: String(out.brief || ""),
  };
}

// reviewCallSpine({ transcript, phase, captured, runner }) -> Promise<spine|null>.
// runner = a THINKER spawn (Sonnet, maxThinkingTokens:null). Returns null if no
// runner or the model returns nothing usable.
async function reviewCallSpine({ transcript, phase, captured, runner } = {}) {
  if (typeof runner !== "function") return null;
  try {
    const res = await runner(buildSpineRequest({ transcript, phase, captured }));
    return parseSpineResult(res);
  } catch (_) {
    return null; // a failed spine review must never break the call
  }
}

// Cadence gate: review the spine every `everyTurns` coachable turns. Off the fast
// path, so the cadence can be generous.
function shouldReviewSpine(turnIndex, lastReviewTurn, everyTurns = 6) {
  if (!Number.isFinite(turnIndex)) return false;
  const last = Number.isFinite(lastReviewTurn) ? lastReviewTurn : -Infinity;
  return turnIndex - last >= everyTurns;
}

module.exports = {
  SPINE_SCHEMA,
  SPINE_SYSTEM,
  buildSpineRequest,
  parseSpineResult,
  reviewCallSpine,
  shouldReviewSpine,
};
