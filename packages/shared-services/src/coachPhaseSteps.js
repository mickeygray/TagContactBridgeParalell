"use strict";

// Per-phase step checklists — the beats an agent works through WITHIN a phase.
//
// Phase tells you WHERE the call is; steps tell you what still has to happen here
// before advancing. Each step is recognized (an agent-side marker). The UI renders
// the current phase's checklist PASSIVELY (stepChecklist) — a beat just shows
// checked or unchecked. The list never nudges on its own: a not-yet-done beat is an
// ORCHESTRATOR INPUT (pendingSteps) the orchestrator MAY turn into a feedback item
// on the single live-feedback channel ("you haven't named the firm yet"), so every
// reminder comes from that one channel, not from the list.
//
// Discovery's steps ARE the DiscoveryItems (balance, unfiled, ...), recognized via
// captured facts from the extractor — so discovery has no markers here; its
// completed steps come from `capturedFacts`. Every other phase uses the markers
// below. Anchored to the WYNN consultative + universal scripts.

const PHASE_STEPS = {
  intro: [
    { id: "identify_self", label: "Identify yourself" },
    { id: "identify_company", label: "Name the firm" },
    { id: "confirm_prospect", label: "Confirm the prospect" },
  ],
  discovery: [
    { id: "balance", label: "Balance owed" },
    { id: "unfiled_years", label: "Unfiled years" },
    { id: "collection_status", label: "Collection status" },
    { id: "income_type", label: "Income type" },
    { id: "ability_to_pay", label: "Ability to pay" },
  ],
  expert: [
    { id: "explain_factors", label: "Explain owed / filed / on-record" },
    { id: "tie_to_case", label: "Tie it to their situation" },
    { id: "pain_relief", label: "Stop-guessing bridge" },
  ],
  pitch: [
    { id: "explain_representation", label: "Representation first" },
    { id: "explain_forms", label: "Forms 2848 / 8821" },
    { id: "set_expectation", label: "Marathon, not a sprint" },
    { id: "differentiate", label: "No big promises" },
  ],
  payment: [
    { id: "state_fee", label: "State the flat fee" },
    { id: "anchor_full", label: "Anchor paid-in-full" },
    { id: "offer_structure", label: "Offer a split if needed" },
    { id: "secure_commitment", label: "Get the commitment" },
  ],
  info: [
    { id: "collect_name", label: "Full legal name" },
    { id: "collect_contact", label: "Email + phone" },
    { id: "collect_dob", label: "Date of birth" },
    { id: "collect_ssn", label: "SSN (at signing)" },
    { id: "collect_payment", label: "Payment method" },
  ],
  close: [
    { id: "summarize", label: "Summarize the plan" },
    { id: "reinforce_value", label: "Reinforce the value" },
    { id: "set_welcome_call", label: "Confirm welcome call" },
  ],
};

// Agent-side recognition markers for the non-discovery steps.
const STEP_MARKERS = {
  identify_self: /this is \w+|my name is|i'?m \w+ (with|from|at|calling)|calling from/,
  identify_company: /wynn tax|the tax group|tax advocate|tax (resolution|relief) firm|licensed.*(tax )?firm/,
  confirm_prospect: /is this \w+|am i (speaking|talking) (with|to)|speaking (with|to) \w+|may i ask who/,
  explain_factors: /what'?s owed|owed.*filed.*record|three factors|comes down to/,
  tie_to_case: /in your case|for you specifically|cases like yours/,
  pain_relief: /stop guessing|work(ing)? with facts|calm, informed/,
  explain_representation: /get(ting)? you represented|representation is the (first|starting)|formally represent/,
  explain_forms: /\b2848\b|\b8821\b|power of attorney/,
  set_expectation: /marathon|not a sprint|each step|takes time/,
  differentiate: /we don'?t (rush|over-?promise)|responsible path|not.*big promises/,
  state_fee: /flat (legal )?fee|the fee (is|for)|\$\s?\d/,
  anchor_full: /all at once|take care of it.*today|paid in full/,
  offer_structure: /split it|two payments|four (monthly )?payments|\$350/,
  secure_commitment: /which works best|ready to (get )?start|get.*started today/,
  collect_name: /full legal name|your (full )?name/,
  collect_contact: /email|phone number|best number/,
  collect_dob: /date of birth|\bdob\b/,
  collect_ssn: /social security|\bssn\b/,
  collect_payment: /\bcard\b|payment method|debit or credit/,
  summarize: /to summarize|to recap|so to confirm/,
  reinforce_value: /representation is the foundation|where you stand/,
  set_welcome_call: /welcome call|within (one|1) business day|confirmation email/,
};

function phaseSteps(phaseId) {
  return PHASE_STEPS[phaseId] || [];
}

// recognizeSteps(turn) -> Set<stepId>. Agent-side marker steps only; discovery
// steps come from capturedFacts (merge them in at the caller).
function recognizeSteps(turn = {}) {
  const done = new Set();
  if (String(turn.role || "").toLowerCase() !== "agent") return done;
  const text = String(turn.text || "").toLowerCase();
  for (const [id, re] of Object.entries(STEP_MARKERS)) if (re.test(text)) done.add(id);
  return done;
}

function asSet(completed) {
  return completed instanceof Set ? completed : new Set(completed || []);
}

// The current phase's checklist with done flags — what the UI renders.
function stepChecklist(phaseId, completed) {
  const set = asSet(completed);
  return phaseSteps(phaseId).map((s) => ({ ...s, done: set.has(s.id) }));
}

// The not-yet-done beats of the current phase — an orchestrator INPUT that MAY be
// turned into a feedback item; NOT rendered as a nudge by the checklist itself.
function pendingSteps(phaseId, completed) {
  const set = asSet(completed);
  return phaseSteps(phaseId).filter((s) => !set.has(s.id));
}

module.exports = {
  PHASE_STEPS,
  STEP_MARKERS,
  phaseSteps,
  recognizeSteps,
  stepChecklist,
  pendingSteps,
};
