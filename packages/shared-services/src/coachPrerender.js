"use strict";

// SPECULATIVE PRE-RENDER — eliminate the live model call.
//
// Instead of generating a nudge on the live moment (~5s), the once-a-minute reader
// (Sonnet) PREDICTS the coaching opportunities likely to be relevant now/imminently,
// Haiku PRE-RENDERS each into a ready card, and the live "send" becomes an INSTANT
// selection — a deterministic cue match auto-surfaces a card, or the agent clicks
// the "thought bubble" they're hearing. No model call on the live path.
//
// The blast of pre-render work is OFF the live path (flat-cost Max). Predictable
// moments are instant; a novel moment with no matching card falls back to a live
// render. Reuses the composer (render) + pullSkill (per-card doctrine).

const { buildComposerRequest, parseComposerResult } = require("./coachComposer");
const { pullSkill, matchSkillKeys } = require("./coachSkills");

const OPPORTUNITIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opportunities"],
  properties: {
    opportunities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "cue"],
        properties: {
          id: { type: "string" },
          label: { type: "string", description: "the situation, e.g. 'price objection', 'asks how long it takes'" },
          cue: { type: "string", description: "what the prospect is likely to SAY that triggers this (used to match the live turn)" },
          skillKey: { type: ["string", "null"], description: "objection-bank skill key, if one fits" },
          priority: { type: "number" },
        },
      },
    },
  },
};

const OPPORTUNITIES_SYSTEM = [
  "You are the navigator for a live tax-resolution sales call (Wynn Tax).",
  "Read the transcript and predict the 3-6 coaching opportunities most likely to be",
  "relevant NOW or imminently — the objections, questions, and moments the agent",
  "should be ready for given where the call is. For each: a short situation label, a",
  "cue (what the prospect is likely to SAY that triggers it), and an optional skill",
  "key. Output ONLY the JSON object.",
].join(" ");

function buildOpportunitiesRequest({ transcript, phase, captured, caseContext } = {}) {
  const lines = [];
  lines.push("Phase: " + (phase || "intro") + (Array.isArray(captured) && captured.length ? "; known: " + captured.join(", ") : ""));
  if (caseContext) lines.push("Case (from the agent's interview): " + caseContext);
  lines.push("Transcript so far:");
  lines.push(String(transcript || "").trim() || "(empty)");
  lines.push("Predict the coaching opportunities (specific to THIS case) as JSON {opportunities:[{id,label,cue,skillKey,priority}]}.");
  return { system: OPPORTUNITIES_SYSTEM, prompt: lines.join("\n"), schema: OPPORTUNITIES_SCHEMA };
}

function parseOpportunities(res) {
  const out = res && (res.json || (typeof res === "object" && !res.ok ? null : res));
  const list = out && Array.isArray(out.opportunities) ? out.opportunities : [];
  return list
    .filter((o) => o && typeof o === "object" && o.label)
    .map((o, i) => ({
      id: String(o.id || `opp${i}`),
      label: String(o.label),
      cue: String(o.cue || ""),
      skillKey: typeof o.skillKey === "string" && o.skillKey ? o.skillKey : null,
      priority: Number.isFinite(o.priority) ? o.priority : 0,
    }));
}

// predictOpportunities — the once-a-minute READER (inject a Sonnet thinker runner).
async function predictOpportunities({ transcript, phase, captured, caseContext, runner } = {}) {
  if (typeof runner !== "function") return [];
  try {
    return parseOpportunities(await runner(buildOpportunitiesRequest({ transcript, phase, captured, caseContext })));
  } catch (_) {
    return [];
  }
}

// prerenderCard — render ONE opportunity into a ready guidance card (Haiku composer,
// 0 thinking). The opportunity's cue is framed as the anticipated prospect line.
async function prerenderCard(opp, { composerRunner, phase, caseContext, now = 0, ttlMs = 90000 } = {}) {
  if (typeof composerRunner !== "function" || !opp) return null;
  const turn = { role: "prospect", text: opp.cue || opp.label };
  const pulled = pullSkill({ turn, phase, overrideKey: opp.skillKey || undefined });
  const req = buildComposerRequest({ turn, candidates: [], state: { phase, caseContext }, system: pulled.system });
  const item = parseComposerResult(await composerRunner(req), { id: `card_${opp.id}`, at: now, ttlMs });
  if (!item) return null;
  return { ...opp, skillKeys: pulled.skillKeys, card: item };
}

// prerenderCards — the BLAST: render every opportunity in parallel (off the live
// path). Caller throttles concurrency if needed.
async function prerenderCards(opportunities = [], deps = {}) {
  const rendered = await Promise.all(opportunities.map((o) => prerenderCard(o, deps).catch(() => null)));
  return rendered.filter(Boolean);
}

// matchCard(turn, cards) -> the pre-rendered card whose situation the live turn hits,
// or null. Deterministic + instant (no model). Skill-key match is the strong signal;
// cue-word overlap is the fallback. Highest-priority winner.
function matchCard(turn, cards = []) {
  const text = String((turn && turn.text) || "").toLowerCase();
  if (!text.trim() || !cards.length) return null;
  const skillKeys = new Set(matchSkillKeys(text));
  const scored = cards
    .map((c) => {
      let score = 0;
      if (c.skillKey && skillKeys.has(c.skillKey)) score += 100;
      const cueWords = String(c.cue || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
      score += cueWords.filter((w) => text.includes(w)).length;
      return { c, score: score + (c.priority || 0) / 1000 };
    })
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].c : null;
}

module.exports = {
  OPPORTUNITIES_SCHEMA,
  OPPORTUNITIES_SYSTEM,
  buildOpportunitiesRequest,
  parseOpportunities,
  predictOpportunities,
  prerenderCard,
  prerenderCards,
  matchCard,
};
