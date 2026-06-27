"use strict";

// coachSkills — situation-level "skills" = near-complete composer prompts.
//
// The composer's prompt is ~90% pre-written and ~10% live specificity. The 90% is:
// the phase doctrine (always present) PLUS, when the turn matches a known situation,
// that situation's specific overcoming strategy — pulled from the EXISTING
// liveCoachObjectionBank (read/reframe/moves/lines per objection). The only thing
// added per turn is the transcription. The composer renders the filled result at 0
// thinking; it never "pulls" — the pull happens here, before the spawn.
//
// The PULL is deterministic (keyword match over the bank's own keywords) with a
// PHASE-doctrine FALLBACK on a miss — never all-or-nothing, so a missed match
// degrades to the competent phase template, not silence. The async navigator may
// pass an overrideKey to refine the choice. Reuses the bank's matcher data + its
// formatter (which already handles DNC compliance-preemption).

const {
  OBJECTION_PLAYBOOK,
  getObjectionPlaybook,
  formatObjectionPlaybookForPrompt,
} = require("./liveCoachObjectionBank");
const { selectComposerSystem } = require("./coachComposerSystems");

// matchSkillKeys(text) -> [objectionKey,...] ranked by priority. Deterministic
// lowercase-substring match over each entry's keywords. Over-inclusive by design;
// the formatter caps to the top entries.
function matchSkillKeys(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return [];
  return OBJECTION_PLAYBOOK.filter(
    (e) => Array.isArray(e.keywords) && e.keywords.some((k) => hay.includes(String(k).toLowerCase()))
  )
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((e) => e.key);
}

// pullSkill({ turn, phase, overrideKey }) -> { system, skillKeys, source }.
// system    = the near-complete composer prompt (phase doctrine + matched objection
//             playbook, or phase doctrine alone on a miss).
// skillKeys = what was pulled (provenance for the feedback item / cockpit).
// source    = "objection" (a situation skill fired) | "phase" (fallback).
function pullSkill({ turn, phase, overrideKey } = {}) {
  const base = selectComposerSystem(phase); // the phase doctrine — the always-present 90%
  const keys = overrideKey
    ? [overrideKey].filter((k) => getObjectionPlaybook(k)) // navigator's choice wins (if valid)
    : matchSkillKeys((turn && turn.text) || "");
  if (!keys.length) return { system: base, skillKeys: [], source: "phase" };
  const block = formatObjectionPlaybookForPrompt(keys, { maxEntries: 2 });
  if (!block) return { system: base, skillKeys: [], source: "phase" };
  return { system: `${base}\n\n${block}`, skillKeys: keys.slice(0, 2), source: "objection" };
}

module.exports = { matchSkillKeys, pullSkill };
