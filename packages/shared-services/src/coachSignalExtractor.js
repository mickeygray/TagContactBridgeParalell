"use strict";

// Deterministic coach signal extractor (demo / first pass).
//
// Turns a transcript turn { role, text } into (a) the agent-side phase MARKERS the
// phase machine eats, and (b) the prospect's captured DiscoveryItem FACTS. Pure,
// pattern-based, anchored to the WYNN consultative script. This proves the loop;
// the production version wires the same signals off the existing match-bank
// (liveCoachContextMatchBank / CONTEXT_RULES) + the DiscoveryItem registry.
//
// Two roles, two jobs: markers come from what the AGENT does (frames the POA,
// quotes the fee, asks for the SSN); facts come from what the PROSPECT reveals
// (so the agent ASKING "how much do you owe?" does not capture a balance).

// Agent-side phase markers (fire only on agent turns).
const AGENT_MARKERS = [
  { key: "discoveryAsked", re: /can i ask|few quick questions|how much.*(owe|balance)|do you (know|owe)|any years.*(un)?filed|haven'?t filed yet|are you (being |currently )?(garnish|levied)|worked with (anyone|a)/ },
  { key: "expertExplained", re: /what we typically see|here'?s what (we|the irs|happens)|every tax case|let me explain|comes down to|once (you'?re |we'?re )?represented|the irs (files|flag)/ },
  { key: "representationFramed", re: /power of attorney|form 2848|\b2848\b|\b8821\b|\bpoa\b|formally represent|get you represented|represent you|representation is the (first|starting)/ },
  { key: "feeQuoted", re: /\$\s?\d|flat (legal )?fee|legal fee (is|for)|the fee (is|for)|fee for representation|eighteen hundred|hundred dollars|per month/ },
  { key: "infoCollectionStarted", re: /social security|\bssn\b|date of birth|\bdob\b|full legal name|card on file|payment method|debit or credit|get your file started|let'?s get.*started/ },
  { key: "ssnOrPaymentCaptured", re: /card ending|docusign|signed|here'?s my (social|card)|payment.*(received|confirmed)/ },
  { key: "closeSummary", re: /to summarize|to recap|welcome call|within (one|1) business day|you'?ll receive|next steps|thank you for taking the time/ },
];

// Prospect-side DiscoveryItem facts (fire only on prospect turns).
const FACT_MARKERS = [
  { id: "balance", re: /\$\s?\d|thousand|\bk\b|owe (about|around|roughly)?\s*\d|thirty|forty|fifty|sixty/ },
  { id: "unfiled_years", re: /didn'?t file|haven'?t filed|un-?filed|behind on|missing.*return|couldn'?t deal|never filed|\b20\d\d\b/ },
  { id: "collection_status", re: /garnish|\blevy\b|levied|\blien\b|letter|notice|taking.*(money|paycheck)|\bcp\s?\d/ },
  { id: "income_type", re: /\bw-?2\b|self-?employed|\b1099\b|salary|hourly|my job|i work|paycheck|business owner/ },
  { id: "ability_to_pay", re: /afford|can'?t pay|that'?s a lot|all at once|up ?front|too much|tight right now/ },
];

const ALL_MARKER_KEYS = AGENT_MARKERS.map((m) => m.key);

function isAgentTurn(role) {
  return String(role || "").toLowerCase() === "agent";
}

// extractTurnSignals(turn) -> { <marker booleans> }. Every key always present.
function extractTurnSignals(turn = {}) {
  const text = String(turn.text || "").toLowerCase();
  const agent = isAgentTurn(turn.role);
  const out = {};
  for (const m of AGENT_MARKERS) out[m.key] = agent && m.re.test(text);
  return out;
}

// extractCapturedFacts(turn) -> Set<DiscoveryItem id>. Only prospect turns capture
// facts (an agent question is not an answer).
function extractCapturedFacts(turn = {}) {
  if (isAgentTurn(turn.role)) return new Set();
  const text = String(turn.text || "").toLowerCase();
  const facts = new Set();
  for (const m of FACT_MARKERS) if (m.re.test(text)) facts.add(m.id);
  return facts;
}

module.exports = {
  extractTurnSignals,
  extractCapturedFacts,
  AGENT_MARKERS,
  FACT_MARKERS,
  ALL_MARKER_KEYS,
};
