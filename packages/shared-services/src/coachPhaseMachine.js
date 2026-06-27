"use strict";

// Coach call-phase state machine — the authoritative phase truth (server-side).
//
// Phase is NOT a client heuristic and NOT a per-turn LLM classification. It is a
// conservative reducer with three rules:
//   1. advance-biased — moves forward through the arc, regresses only one step on
//      an explicit navigator proposal.
//   2. hysteresis via sticky markers — a phase change rests on observed evidence
//      (a fee was quoted, the POA was framed), not on a single ambiguous turn.
//   3. propose-not-dispose — the navigator (Sonnet, ~1/min) may PROPOSE a phase;
//      the machine GATES it. The machine owns the truth; the model only suggests.
//
// Markers are anchored to observable moments in the WYNN consultative script
// (Tax Group): a dollar fee -> payment; "Power of Attorney / 2848 / 8821" ->
// pitch; asking SSN/DOB/payment -> info; "to summarize / welcome call" -> close.
// The deterministic extractor (reuse the match-bank + DiscoveryItem registry)
// fills `signals`; this module is a pure reducer over them. Zero I/O, fully
// testable offline (mirrors cxBulkLoadStateMachine).

const PHASES = [
  { id: "intro", order: 0, factsDue: [], advanceGoal: "Get permission and ask the first discovery question." },
  { id: "discovery", order: 1, factsDue: ["balance", "unfiled_years", "collection_status", "income_type", "ability_to_pay"], advanceGoal: "Capture balance, unfiled years, collection status, income type, and ability to pay." },
  { id: "expert", order: 2, factsDue: [], advanceGoal: "Frame the problem and show expertise before pitching." },
  { id: "pitch", order: 3, factsDue: [], advanceGoal: "Pitch representation: POA, Forms 2848/8821, transcripts, compliance review." },
  { id: "payment", order: 4, factsDue: [], advanceGoal: "Present the flat fee; run the payment ladder on resistance." },
  { id: "info", order: 5, factsDue: [], advanceGoal: "Collect full name, address, DOB, SSN, and payment method." },
  { id: "close", order: 6, factsDue: [], advanceGoal: "Summarize, set expectations, confirm the welcome call." },
];

// The core discovery facts that gate Discovery -> Expert (the rest are nice-to-have).
const CORE_DISCOVERY = ["balance", "unfiled_years", "collection_status"];

const PHASE_BY_ID = new Map(PHASES.map((p) => [p.id, p]));
const orderOf = (id) => (PHASE_BY_ID.has(id) ? PHASE_BY_ID.get(id).order : 0);

// Sticky markers: once observed, they stay true for the rest of the call (a fee
// quoted in turn 9 is still "quoted" at turn 20). The extractor passes per-turn
// fresh booleans; we OR them into the accumulated set.
const MARKER_KEYS = [
  "discoveryAsked",
  "expertExplained",
  "representationFramed",
  "feeQuoted",
  "infoCollectionStarted",
  "ssnOrPaymentCaptured",
  "closeSummary",
];

function mergeSeen(seen = {}, signals = {}) {
  const out = {};
  for (const key of MARKER_KEYS) out[key] = Boolean(seen[key]) || Boolean(signals[key]);
  return out;
}

function coreCount(captured) {
  let n = 0;
  for (const id of CORE_DISCOVERY) if (captured.has(id)) n += 1;
  return n;
}

// Entry condition for each non-intro phase: the MARKER that fires to advance into
// it, and the GATE that must hold to allow the entry (propose-not-dispose).
const ENTRY = {
  discovery: { marker: (seen) => seen.discoveryAsked, gate: () => true },
  // Advance when the agent explains the situation OR all core facts are in; gated
  // on at least two core facts so we never enter Expert on an empty discovery.
  expert: { marker: (seen, caps) => seen.expertExplained || coreCount(caps) >= CORE_DISCOVERY.length, gate: (seen, caps) => coreCount(caps) >= 2 },
  pitch: { marker: (seen) => seen.representationFramed, gate: () => true },
  // A fee number means Payment — but only if representation was actually framed
  // (a stray dollar amount mid-discovery must NOT jump us to the ladder).
  payment: { marker: (seen) => seen.feeQuoted, gate: (seen) => seen.representationFramed },
  // Collecting PII means Info — but only after a fee was quoted (can't be closing
  // out the sale before there is one).
  info: { marker: (seen) => seen.infoCollectionStarted, gate: (seen) => seen.feeQuoted },
  close: { marker: (seen) => seen.closeSummary || seen.ssnOrPaymentCaptured, gate: () => true },
};

function freshState(phase, since, seen) {
  return { phase, since, seen };
}

// reduceCoachPhase(state, signals) -> { state, changed, reason }
//
// state   : { phase, since, seen }  (seed with undefined/null on first call)
// signals : { <marker booleans>, capturedFacts:[ids], proposedPhase, proposalReason, turnCount }
//
// Pure. Default action is STAY. Advances to the FURTHEST forward phase whose entry
// marker has fired AND whose gate holds (skip-ahead allowed but reported). A
// navigator proposal can push further (gated) or regress exactly one step.
function reduceCoachPhase(state, signals = {}) {
  const prev = state && state.phase ? state : freshState("intro", 0, {});
  const seen = mergeSeen(prev.seen, signals);
  const captured = new Set(Array.isArray(signals.capturedFacts) ? signals.capturedFacts : []);
  const turn = Number.isFinite(Number(signals.turnCount)) ? Number(signals.turnCount) : prev.since;
  const curOrder = orderOf(prev.phase);

  // 1. Furthest forward phase reachable by a fired marker + passing gate.
  let targetId = prev.phase;
  let targetOrder = curOrder;
  for (const p of PHASES) {
    if (p.order <= curOrder) continue;
    const entry = ENTRY[p.id];
    if (entry && entry.marker(seen, captured) && entry.gate(seen, captured)) {
      targetId = p.id;
      targetOrder = p.order;
    }
  }

  // 2. Navigator forward proposal — only honored past the marker target and gated.
  const prop = signals.proposedPhase;
  if (prop && PHASE_BY_ID.has(prop)) {
    const propOrder = orderOf(prop);
    if (propOrder > targetOrder) {
      const entry = ENTRY[prop];
      if (!entry || entry.gate(seen, captured)) {
        targetId = prop;
        targetOrder = propOrder;
      }
    } else if (propOrder === curOrder - 1) {
      // 3. Conservative single-step regress (the call genuinely looped back).
      return {
        state: freshState(prop, turn, seen),
        changed: true,
        reason: `regress ${prev.phase}->${prop}: ${signals.proposalReason || "navigator"}`,
      };
    }
  }

  if (targetOrder === curOrder) {
    return { state: freshState(prev.phase, prev.since, seen), changed: false, reason: "stay" };
  }
  const reason = targetOrder - curOrder > 1 ? `skip-ahead ${prev.phase}->${targetId}` : `advance ${prev.phase}->${targetId}`;
  return { state: freshState(targetId, turn, seen), changed: true, reason };
}

function phaseDefinition(id) {
  return PHASE_BY_ID.get(id) || null;
}

module.exports = {
  PHASES,
  CORE_DISCOVERY,
  reduceCoachPhase,
  phaseDefinition,
  orderOf,
};
