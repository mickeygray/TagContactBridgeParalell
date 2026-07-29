"use strict";

// ENGRAVED HARD RULES — the boundaries that hold in EVERY section and module.
//
// Mickey 2026-07-29: "it doesnt have to be word for word on certain things but
// there are definite boundaries... if you half promise something — things that
// are hard engraved as rules for not to do."
//
// Two tiers, deliberately different:
//   · criteria  — the moves, in the learner's own words, graded semantically
//   · HARD RULES — absolute nevers; a verified violation ends the run
//
// Every rule cites its source. An engraved rule with no authority is exactly
// the invented doctrine the review process exists to kill — do not add one.

const HARD_RULE_REVISION = "engraved-boundaries-1";

function hardRule(ruleId, statement, detectionGuidance, authority) {
  return Object.freeze({
    ruleId: `hard.${ruleId}`,
    kind: "never",
    revision: HARD_RULE_REVISION,
    statement,
    detectionGuidance,
    appliesTo: "all",
    runEnding: true,
    authority: Object.freeze(authority),
  });
}

const TAX_RESOLUTION_HARD_RULES = Object.freeze([
  hardRule(
    "promise-outcome",
    "Never promise or half-promise a result: no settlement amounts, no OIC, no savings figures, no dates, no \"you'll probably qualify.\"",
    "Violation = any committed or hedged outcome claim — a dollar figure they will save, a program they will get, a timeline the IRS will honor, or odds of success. Describing what the FIRM does (file representation, pull transcripts, request a hold) is not a violation.",
    {
      type: "field-manual-extract",
      source: "apps/web-client/src/workspaces/field-manual/content/objections-trust.ts",
      note: "\"Never promise a result, an OIC, a dollar figure, or a date... guarantee-talk is both a compliance violation and the fastest way to confirm their scam fear.\" Reinforced by the approved script's differentiate beat: \"A lot of companies rush to big promises. We don't.\"",
    },
  ),
  hardRule(
    "misrepresent-the-firm",
    "Never misstate who the firm is — it is a licensed tax representation firm — and never state or imply the call is from the IRS or a government agency.",
    "Violation = claiming or implying to be the IRS/state, or identifying the firm as something it is not. Choosing not to repeat the full identity mid-conversation is NOT a violation; misstating it is.",
    {
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      note: "who_we_are beat: \"A LICENSED TAX REPRESENTATION FIRM — enrolled agents, tax preparers, consultants.\" The engraved rule is the negation of the required identity.",
    },
  ),
  hardRule(
    "forms-fix-the-debt",
    "Never claim the authorization forms change, reduce, or settle the balance.",
    "Violation = presenting the 2848/8821/state POA as themselves fixing or shrinking the debt. Presenting them as the door-opener for facts and lawful communication is the approved framing.",
    {
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      note: "foundation_not_fix beat: \"These forms don't change your balance; they open the door so we can see the facts and communicate lawfully.\"",
    },
  ),
  hardRule(
    "fee-outside-terms",
    "Never quote, discount, or negotiate the fee outside the Representation fee line and the Payment Terms structure.",
    "Violation = naming a fee amount or bargaining terms during Introduction, Discovery, Expert Guidance, or Information Collection, or improvising a discount anywhere. Stating the flat fee in section 4 and walking the ladder in 4B is the approved path.",
    {
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      note: "The fee exists only in the fee_line beat (section 4) and the 4B ladder; Discovery's packet independently prohibits \"quoting a fee\".",
    },
  ),
  hardRule(
    "fabricate-the-record",
    "Never invent specifics about the prospect's IRS record, transcripts, or case status before the record has been pulled.",
    "Violation = asserting facts about their file that nobody can see yet (\"your transcripts show...\", \"the IRS has already flagged you for...\"). Naming what typically happens in situations like theirs, per the guidance section, is not a violation.",
    {
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      note: "three_factors beat: \"Until someone represents you, the IRS makes it hard to see the full details\"; pain_relief_bridge: \"stop guessing and start working with facts.\"",
    },
  ),
  hardRule(
    "attack-the-incumbent",
    "Never attack or run down the prospect's current CPA, preparer, or a prior firm.",
    "Violation = disparaging the incumbent's competence or honesty. Auditing what the incumbent has actually done — respectfully, with questions — is the approved play.",
    {
      type: "field-manual-extract",
      source: "apps/web-client/src/workspaces/field-manual/content/objections-capability.ts",
      note: "The capability-objection doctrine: audit the incumbent, never attack it.",
    },
  ),
]);

module.exports = {
  HARD_RULE_REVISION,
  TAX_RESOLUTION_HARD_RULES,
};
