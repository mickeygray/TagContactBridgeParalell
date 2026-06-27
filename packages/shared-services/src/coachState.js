"use strict";

// CoachState — the authoritative, server-owned coach state the front end RENDERS
// (it computes nothing; see docs/COACH_FRONTEND_CONNECTION_PLAN_2026-06-24.md).
//
// The wire shape, the rev-ordered delta merge, and the loudest-signal `mode`
// selector all live here as pure functions so both the server (assembles state +
// emits deltas) and the client (applies deltas + renders) import ONE source of
// truth. Zero I/O; fully testable offline.
//
// ── Live feedback is ONE channel ────────────────────────────────────────────
// Every reactive coaching output — a nudge, an objection rebuttal, a sales
// opportunity, a compliance warning, a skipped-beat / skipped-discovery reminder —
// is a single typed item on the `feedback` array. The coach picks ONE loudest item
// to show (selectFeedback); that is the only place live feedback renders. The
// phase-step + discovery checklists are PASSIVE: they render checkmarks from what
// the AI has recognized and emit no feedback of their own (a skipped beat shows as
// an unchecked box; the *reminder* about it is a feedback item produced by the
// orchestrator, not by the list).
//
// A FeedbackItem:
//   {
//     id,        // stable; keyed-append history + dedup
//     kind,      // "nudge" | "objection" | "opportunity" | "compliance" | "steer_back"
//     severity,  // "info" | "warn" | "block" | "critical"  (block|critical = hard interrupt)
//     read,      // situation read
//     steer,     // what to do (carries objection.reframe / steer-back guidance)
//     try,       // suggested line (OPTIONAL — Steer-only allowed; WAIT escape preserved)
//     at,        // emit time (drives TTL)
//     ttlMs,     // relevance half-life; compliance/steer_back emit long/absent ttl = "present until cleared"
//     priority,  // numeric tie-break (objection-bank priority / pressure class); higher wins
//     source,    // provenance: "navigator"|"objectionBank"|"play"|"complianceGate"|"phaseSteps" (not rendered)
//     phase,     // phase id it was authored under (optional)
//     moves, lines // OPTIONAL rich objection payload, carried so it is not flattened away
//   }
// Expert/tax framing (CONTEXT_RULES) and posture/psychology tactics (TACTIC_RULES)
// are NOT separate kinds: they are composition INPUTS the navigator folds INTO an
// item's read/steer/try text, so they ride inside a nudge/objection item.

const { CORE_DISCOVERY, orderOf } = require("./coachPhaseMachine");

const FEEDBACK_KINDS = ["nudge", "objection", "opportunity", "compliance", "steer_back"];

// Loudest-signal ladders. Severity is primary (safety); kind reproduces the old
// mode order (reaction-family > steer_back > play). block|critical never rank here
// — they win as an absolute compliance tier, ahead of any liveness check.
const SEVERITY_RANK = { critical: 4, block: 3, warn: 2, info: 1 };
const KIND_RANK = { compliance: 5, objection: 4, nudge: 4, steer_back: 2, opportunity: 1, play: 1 };
const KIND_TO_MODE = {
  objection: "reaction",
  nudge: "reaction",
  opportunity: "play",
  play: "play",
  steer_back: "steer_back",
  compliance: "compliance",
};

const EMPTY_COACH_STATE = {
  session: null, // { id, callId, agent, status, startedAt }
  phase: { current: "intro", order: 0, advanceGoal: "", since: 0, steps: [] }, // steps: passive [{id,label,done}]
  discovery: { items: [], missing: [] }, // items: [{ id, label, captured, value }]
  feedback: [], // the ONE live-feedback channel — [FeedbackItem]
  reaction: null, // LEGACY single-item form { id, read, steer, try, at, ttlMs }; no longer a mode source
  play: null, // play TRACKER { id, label, rungs:[{ id, label, state }], currentRung } — rendered as the ladder, not a mode source
  compliance: { flags: [] }, // [{ severity, message }] — gate output; severity-only hard interrupt
  mode: "quiet", // quiet | reaction | play | steer_back | compliance | post_call
  grade: null, // post-call only
  rev: 0, // monotonic; deltas merge in rev order
};

function normalizeCoachState(state) {
  if (!state || typeof state !== "object") return { ...EMPTY_COACH_STATE };
  return {
    ...EMPTY_COACH_STATE,
    ...state,
    phase: { ...EMPTY_COACH_STATE.phase, ...(state.phase || {}) },
    discovery: { ...EMPTY_COACH_STATE.discovery, ...(state.discovery || {}) },
    compliance: { ...EMPTY_COACH_STATE.compliance, ...(state.compliance || {}) },
    feedback: Array.isArray(state.feedback) ? state.feedback : [],
    rev: Number.isFinite(Number(state.rev)) ? Number(state.rev) : 0,
  };
}

// Slices replaced wholesale when present in a delta (object identity = "this slice
// changed"). The `feedback` array is a slice too — wholesale-replace IS the
// channel's clear/supersede protocol (emit [] to clear; rides the rev gate so a
// stale tick can never clobber). reaction is handled separately because `null` is a
// meaningful value (clear the legacy nudge), not "absent".
const DELTA_SLICES = ["session", "phase", "discovery", "feedback", "play", "compliance", "grade", "mode"];

// applyGuideDelta(state, delta) -> next CoachState. PURE. Rev-ordered: a delta
// whose rev is not newer than the current state is IGNORED (the fix for
// out-of-order / duplicate SSE delivery — a stale tick can never clobber).
function applyGuideDelta(state, delta = {}) {
  const base = normalizeCoachState(state);
  if (!delta || typeof delta !== "object") return base;
  const dRev = Number(delta.rev);
  if (Number.isFinite(dRev) && dRev <= base.rev) return base;
  const next = { ...base };
  for (const slice of DELTA_SLICES) {
    if (Object.prototype.hasOwnProperty.call(delta, slice)) next[slice] = delta[slice];
  }
  if (Object.prototype.hasOwnProperty.call(delta, "reaction")) next.reaction = delta.reaction;
  next.rev = Number.isFinite(dRev) ? dRev : base.rev + 1;
  return next;
}

// An item (or legacy reaction) is "live" until its TTL elapses (the ~10-30s
// relevance half-life). `now` injectable for tests; if timing is absent, a present
// item with content counts live.
function isReactionLive(reaction, now) {
  if (!reaction) return false;
  const hasContent = Boolean(reaction.read || reaction.steer || reaction.try);
  if (!hasContent) return false;
  if (!Number.isFinite(Number(now)) || !Number.isFinite(Number(reaction.at)) || !Number.isFinite(Number(reaction.ttlMs))) {
    return true;
  }
  return Number(reaction.at) + Number(reaction.ttlMs) > Number(now);
}

// A feedback item uses the SAME liveness rule as a legacy reaction.
function isFeedbackLive(item, now) {
  return isReactionLive(item, now);
}

function isBlockingItem(item) {
  return Boolean(item) && (item.severity === "block" || item.severity === "critical");
}

function hasBlockingCompliance(compliance) {
  const flags = (compliance && Array.isArray(compliance.flags) && compliance.flags) || [];
  return flags.some((f) => f && (f.severity === "block" || f.severity === "critical"));
}

// Severity-only scan of the channel — mirrors hasBlockingCompliance. Used to pin
// block/critical feedback items to the absolute compliance tier (NO liveness/TTL
// gate), so a fresher nudge can never starve a hard interrupt.
function hasBlockingFeedback(feedback) {
  const items = Array.isArray(feedback) ? feedback : [];
  return items.some(isBlockingItem);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sevRank = (it) => SEVERITY_RANK[it && it.severity] || 0;
const kindRank = (it) => KIND_RANK[it && it.kind] || 0;

// Total order over feedback items — every stage reads a real field so the winner is
// unique and deterministic: severity ↓, kind ↓, priority ↓, recency ↓, id ↑.
function compareFeedback(a, b) {
  return (
    sevRank(b) - sevRank(a) ||
    kindRank(b) - kindRank(a) ||
    num(b.priority) - num(a.priority) ||
    num(b.at) - num(a.at) ||
    String((a && a.id) || "").localeCompare(String((b && b.id) || ""))
  );
}

// selectFeedback(state, opts) -> the single loudest item to render, or null.
// Blocking (block|critical) items bypass the liveness filter and are the pool when
// present (an absolute tier); otherwise the live items are ranked by compareFeedback.
function selectFeedback(state, opts = {}) {
  const s = normalizeCoachState(state);
  const items = s.feedback.filter((it) => it && typeof it === "object");
  if (!items.length) return null;
  const blocking = items.filter(isBlockingItem);
  const pool = blocking.length ? blocking : items.filter((it) => isFeedbackLive(it, opts.now));
  if (!pool.length) return null;
  return [...pool].sort(compareFeedback)[0];
}

// Steer-back is a deterministic condition: the call advanced to Pitch-or-later but
// a CORE discovery fact is still missing (the agent jumped ahead). selectMode no
// longer reads this — the orchestrator MATERIALIZES a kind:"steer_back" feedback
// item when it holds, so the reminder comes from the channel, never from the list.
// Exported as the orchestrator's trigger.
function steerBackNeeded(state) {
  if (!state || !state.phase || orderOf(state.phase.current) < orderOf("pitch")) return false;
  const missing = new Set((state.discovery && state.discovery.missing) || []);
  return CORE_DISCOVERY.some((id) => missing.has(id));
}

// Deterministic loudest-signal precedence — the server's default `mode`, derived
// from the ONE channel. PURE. post_call > compliance(severity-only) > the loudest
// live feedback item (mapped to its render mode) > quiet.
//   - grade short-circuits to post_call (terminal; never an in-channel item).
//   - compliance is severity-only and evaluated BEFORE liveness, from EITHER the
//     legacy compliance.flags OR a block/critical channel item, so a hard interrupt
//     can never be starved by a fresher reaction.
//   - the list (discovery.missing / phase.steps) drives nothing here.
function selectMode(state, opts = {}) {
  const s = normalizeCoachState(state);
  if (s.grade) return "post_call";
  if (hasBlockingCompliance(s.compliance) || hasBlockingFeedback(s.feedback)) return "compliance";
  const top = selectFeedback(s, opts);
  if (top) return KIND_TO_MODE[top.kind] || "reaction";
  return "quiet";
}

module.exports = {
  EMPTY_COACH_STATE,
  FEEDBACK_KINDS,
  normalizeCoachState,
  applyGuideDelta,
  selectMode,
  selectFeedback,
  compareFeedback,
  isReactionLive,
  isFeedbackLive,
  hasBlockingCompliance,
  hasBlockingFeedback,
  steerBackNeeded,
};
