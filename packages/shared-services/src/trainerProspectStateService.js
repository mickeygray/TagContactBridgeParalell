"use strict";

// trainerProspectStateService — the prospect's DISPOSITION LEDGER.
//
// The trainer bot was bimodal (instant roll-over or immovable wall) for one
// reason: it had no memory of its own disposition. Every turn it re-derived
// "how do I feel about this rep?" from the transcript alone, and the prompt's
// two attractors ("advance the call" vs "stay skeptical") made it snap to one
// pole or the other. Trust could not ACCUMULATE and concerns could not stay
// RESOLVED, so there was never a gradual middle.
//
// The fix is the same pattern that made the live coach work (rolling summary +
// phase machine carried forward): explicit state, model-updated, re-injected
// every turn — but with the movement PHYSICS enforced in code, not left to the
// model's goodwill:
//   - trust moves at most +/-1 per turn (no cliff jumps, either direction) —
//     this is what manufactures the missing middle ground;
//   - disclosure is monotonic (you don't un-tell your name);
//   - a RESOLVED concern never reverts to live (recall) — poor later handling
//     spawns a NEW, smaller residual instead of replaying the old objection;
//   - a PARKED concern may resurface at most once, softer, near commitment.
//
// The model emits <PROSPECT_STATE>{...}</PROSPECT_STATE> each turn; the server
// merges it against the prior (clamping per the rules), persists it by
// sessionId, strips the tag from spoken/returned text, and re-injects the
// SANITIZED ledger into the next turn's session header. Pure + injectable so
// the physics is unit-tested without the model in the loop.

const TRUST_MIN = 0;
const TRUST_MAX = 10;
const MAX_TRUST_STEP = 1; // the anti-bimodality clamp

// trust needed before the prospect will part with each thing (advisory to the
// model via the header; the arc "moves down the chain of the sale" as trust rises)
const DISCLOSURE_GATES = Object.freeze({
  name: 3,
  problem: 4,
  numbers: 5,
  hearPitch: 6,
  fee: 7,
  close: 8,
});

const CONCERN_STATUSES = Object.freeze(["live", "engaged", "resolved", "parked"]);
const DISCLOSURE_KEYS = Object.freeze(["name", "problem", "numbers", "sensitive"]);

function clampInt(value, lo, hi, fallback = lo) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function cleanStr(value, max = 200) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function emptyProspectState(overrides = {}) {
  return {
    turn: 0,
    trust: clampInt(overrides.trust, TRUST_MIN, TRUST_MAX, 2), // start guarded, not hostile
    mood: cleanStr(overrides.mood || "guarded, wary of another sales call"),
    disclosed: { name: false, problem: false, numbers: false, sensitive: false },
    concerns: [],
    fishing: Boolean(overrides.fishing),
  };
}

// Extract the LAST <PROSPECT_STATE>{...}</PROSPECT_STATE> JSON from model text.
// Last-wins so a model that (wrongly) emits more than one doesn't confuse us.
const PROSPECT_STATE_TAG = /<PROSPECT_STATE>\s*([\s\S]*?)\s*<\/PROSPECT_STATE>/g;

function parseProspectState(text) {
  const raw = String(text || "");
  let match;
  let last = null;
  PROSPECT_STATE_TAG.lastIndex = 0;
  while ((match = PROSPECT_STATE_TAG.exec(raw)) !== null) last = match[1];
  if (last == null) return null;
  try {
    const parsed = JSON.parse(last);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stripProspectStateTag(text) {
  return String(text || "").replace(/<PROSPECT_STATE>[\s\S]*?<\/PROSPECT_STATE>/g, "");
}

function normalizeConcern(raw, turn) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanStr(raw.id || raw.topic, 48).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) return null;
  let status = cleanStr(raw.status, 12).toLowerCase();
  if (!CONCERN_STATUSES.includes(status)) status = "live";
  return {
    id,
    topic: cleanStr(raw.topic || raw.id, 80),
    status,
    intensity: clampInt(raw.intensity, 1, 5, 3),
    raisedTurn: Number.isFinite(Number(raw.raisedTurn)) ? Number(raw.raisedTurn) : turn,
    resurfacedOnce: Boolean(raw.resurfacedOnce),
  };
}

// Merge the model's proposed next state against the prior, ENFORCING the
// movement physics. `prior` may be null (first turn).
function mergeProspectState(prior, proposed) {
  const base = prior && typeof prior === "object" ? prior : emptyProspectState();
  const next = proposed && typeof proposed === "object" ? proposed : {};
  const turn = clampInt(base.turn, 0, 100000, 0) + 1;

  // 1) TRUST — clamp the step. This is the load-bearing rule: no cliff jumps.
  const priorTrust = clampInt(base.trust, TRUST_MIN, TRUST_MAX, 2);
  const wanted = clampInt(next.trust, TRUST_MIN, TRUST_MAX, priorTrust);
  const delta = Math.max(-MAX_TRUST_STEP, Math.min(MAX_TRUST_STEP, wanted - priorTrust));
  const trust = clampInt(priorTrust + delta, TRUST_MIN, TRUST_MAX, priorTrust);

  // 2) DISCLOSURE — monotonic. Once told, stays told.
  const priorDisc = (base.disclosed && typeof base.disclosed === "object") ? base.disclosed : {};
  const nextDisc = (next.disclosed && typeof next.disclosed === "object") ? next.disclosed : {};
  const disclosed = {};
  for (const key of DISCLOSURE_KEYS) disclosed[key] = Boolean(priorDisc[key]) || Boolean(nextDisc[key]);

  // 3) CONCERNS — recall: a RESOLVED concern can never revert to live/engaged;
  //    a PARKED one may resurface at most once. New concerns are allowed freely.
  const priorConcerns = new Map(
    (Array.isArray(base.concerns) ? base.concerns : [])
      .map((c) => normalizeConcern(c, turn))
      .filter(Boolean)
      .map((c) => [c.id, c]),
  );
  const merged = new Map(priorConcerns);
  for (const rawC of Array.isArray(next.concerns) ? next.concerns : []) {
    const c = normalizeConcern(rawC, turn);
    if (!c) continue;
    const was = priorConcerns.get(c.id);
    if (!was) { merged.set(c.id, c); continue; }
    if (was.status === "resolved") {
      // recall: stays resolved regardless of what the model proposes
      merged.set(c.id, { ...was });
      continue;
    }
    if (was.status === "parked") {
      const goingLive = c.status === "live" || c.status === "engaged";
      if (goingLive && was.resurfacedOnce) {
        merged.set(c.id, { ...was }); // already used its one resurfacing
        continue;
      }
      merged.set(c.id, { ...c, resurfacedOnce: was.resurfacedOnce || goingLive, intensity: Math.min(c.intensity, was.intensity) });
      continue;
    }
    // live/engaged may advance freely (engage, resolve, park)
    merged.set(c.id, { ...c, resurfacedOnce: was.resurfacedOnce });
  }

  return {
    turn,
    trust,
    mood: cleanStr(next.mood || base.mood || "guarded"),
    disclosed,
    concerns: [...merged.values()].slice(0, 12),
    fishing: Boolean(base.fishing), // set at session start; the model can't flip it
  };
}

// What the prospect is currently allowed to give, derived from trust — the
// "chain of the sale" as a function of earned trust.
function disclosureAllowances(trust) {
  const t = clampInt(trust, TRUST_MIN, TRUST_MAX, 0);
  const out = {};
  for (const [key, gate] of Object.entries(DISCLOSURE_GATES)) out[key] = t >= gate;
  return out;
}

// Render the sanitized ledger for injection into the next turn's session header.
function formatProspectStateForHeader(state) {
  const s = state && typeof state === "object" ? state : emptyProspectState();
  const allow = disclosureAllowances(s.trust);
  const concernLines = (Array.isArray(s.concerns) ? s.concerns : [])
    .map((c) => `    - ${c.topic} [${c.status}${c.intensity ? `, intensity ${c.intensity}` : ""}]`)
    .join("\n") || "    - (none raised yet)";
  const allowList = Object.entries(allow).filter(([, ok]) => ok).map(([k]) => k).join(", ") || "nothing beyond basic civility yet";
  return [
    "=== YOUR CURRENT STATE (this is where you ARE right now — update it, never reset it) ===",
    `Turn: ${s.turn}   Trust: ${s.trust}/10   Mood: ${s.mood}`,
    `Already disclosed: ${DISCLOSURE_KEYS.filter((k) => s.disclosed && s.disclosed[k]).join(", ") || "nothing yet"}`,
    `At THIS trust level you are willing to give: ${allowList}.`,
    "Your open concerns:",
    concernLines,
    s.fishing ? "NOTE: this session you are a FISHING caller (see <legitimacy_read>). Stay in character." : "",
    "RULES you must obey when you emit your updated <PROSPECT_STATE>:",
    "  - Move trust by AT MOST 1 point this turn, up or down. Real people warm and cool gradually; never jump.",
    "  - A concern you already marked 'resolved' STAYS resolved — do not re-raise it. If handling later slips, raise a NEW, smaller concern instead.",
    "  - Only give up the next thing on the chain once trust has reached its gate (name 3, problem 4, numbers 5, hear the pitch 6, fee 7, close 8).",
  ].filter(Boolean).join("\n");
}

module.exports = {
  TRUST_MIN,
  TRUST_MAX,
  MAX_TRUST_STEP,
  DISCLOSURE_GATES,
  emptyProspectState,
  parseProspectState,
  stripProspectStateTag,
  mergeProspectState,
  disclosureAllowances,
  formatProspectStateForHeader,
};
