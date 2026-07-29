"use strict";

// Real course-content drafts derived only from the approved representation
// methodology in ../taxGroupScript.js. This module is deliberately not imported
// by publishedTrainingContent.v1.js. Promotion remains an explicit product act.

const { TAX_GROUP_SECTIONS } = require("../taxGroupScript");

const CONTENT_VERSION = "1.0.0-draft";
const RULE_REVISION = "approved-representation-script-extract-1";

const sectionById = new Map(TAX_GROUP_SECTIONS.map((section) => [section.id, section]));

function authority(sectionId, beatId) {
  return Object.freeze({
    type: "approved-script",
    source: "packages/shared-services/src/taxGroupScript.js",
    sectionId,
    beatId,
    revision: RULE_REVISION,
  });
}

function criterion(sectionId, beatId, description, evidenceGuidance, options = {}) {
  return Object.freeze({
    criterionId: `tax-resolution.${sectionId}.${beatId}`,
    ruleId: `tax-resolution.${sectionId}.${beatId}`,
    ruleRevision: RULE_REVISION,
    description,
    evidenceGuidance,
    detector: "semantic",
    required: true,
    appliesWhen: options.appliesWhen || null,
    authority: authority(sectionId, beatId),
  });
}

function persona(variantId, posture, behavior, difficulty) {
  return Object.freeze({
    variantId,
    version: CONTENT_VERSION,
    posture,
    behavior,
    difficulty,
    gatePolicy: "identical-required-criteria",
    protectedTraitPolicy: "no-gate-effect",
  });
}

function question(id, prompt, criterionIds) {
  return Object.freeze({
    questionId: id,
    version: CONTENT_VERSION,
    prompt,
    rubricCriterionIds: Object.freeze(criterionIds),
    grading: "server-owned-cited-semantic",
  });
}

function packet(definition) {
  const scriptSection = sectionById.get(definition.sectionId);
  if (!scriptSection) throw new Error(`Unknown approved script section ${definition.sectionId}`);
  const scriptBeatIds = scriptSection.beats.map((beat) => beat.id);
  const criteriaBeatIds = definition.criteria.map((entry) => entry.criterionId.split(".").at(-1));
  if (JSON.stringify(scriptBeatIds) !== JSON.stringify(criteriaBeatIds)) {
    throw new Error(`Skill packet ${definition.id} does not cover its approved script beats in order`);
  }
  return Object.freeze({
    id: definition.id,
    version: CONTENT_VERSION,
    status: "draft",
    authority: Object.freeze({
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      sectionId: definition.sectionId,
      revision: RULE_REVISION,
    }),
    sectionId: definition.sectionId,
    title: scriptSection.title,
    experienceMode: "gauntlet",
    localObjective: definition.localObjective,
    directions: Object.freeze(definition.directions),
    maxTurns: definition.maxTurns,
    maxVisitsPerNode: 2,
    criteria: Object.freeze(definition.criteria),
    personas: Object.freeze(definition.personas),
    situations: Object.freeze(definition.situations),
    prohibitedMoves: Object.freeze(definition.prohibitedMoves),
    retryPolicy: Object.freeze({
      nodeRetryLimit: 1,
      runRetryLimit: 2,
      variantStrategy: "unused-first",
    }),
    reflectionPrompt: definition.reflectionPrompt,
    questions: Object.freeze(definition.questions),
    passPolicy: "all-applicable-required-criteria-with-cited-learner-evidence",
    certificationEligible: false,
  });
}

const INTRODUCTION = packet({
  id: "tax-resolution.introduction",
  sectionId: "1",
  directions: ["inbound", "outbound"],
  localObjective: "Identify the firm and reason for the conversation clearly enough to earn permission to continue.",
  maxTurns: 5,
  criteria: [
    criterion("1", "inbound_greeting", "Use the approved inbound greeting when the session is inbound.", "Cite the learner turn containing the firm greeting, learner name, and invitation to explain the need.", { appliesWhen: { direction: "inbound" } }),
    criterion("1", "outbound_opener", "Use the approved public-records opener and ask whether an active matter still needs representation when outbound.", "Cite the learner turn that explains the public-record basis without pretending the prospect requested the call.", { appliesWhen: { direction: "outbound" } }),
    criterion("1", "who_we_are", "Identify The Tax Group as a licensed tax representation firm and explain its representation purpose.", "Cite the learner turn that identifies the firm and its role without claiming to be the IRS."),
  ],
  personas: [
    persona("intro-curious", "Cautious but willing to listen", "Asks who the caller is and waits for a clear answer.", "foundation"),
    persona("intro-busy", "Impatient", "Says they are busy and requires a concise reason to continue.", "intermediate"),
    persona("intro-suspicious", "Guarded and skeptical", "Asks whether this is the IRS or a scam and challenges legitimacy.", "advanced"),
  ],
  situations: [
    "Inbound caller opens with only: I got a letter and do not know what it means.",
    "Outbound prospect asks who is calling before confirming anything.",
    "Outbound prospect says this sounds like a scam and refuses to share case facts until the firm is identified.",
  ],
  prohibitedMoves: [
    "claiming to be the IRS or a government agency",
    "inventing a lead source",
    "starting Discovery before identity and purpose are established",
    "quoting a fee or attempting a close",
  ],
  reflectionPrompt: "What did you say that made the identity and purpose of the call clear? Where did you ask for permission to continue?",
  questions: [
    question("intro-why-public-records", "What must an outbound opener explain before moving into the case?", ["tax-resolution.1.outbound_opener"]),
    question("intro-who-we-are", "How should you describe The Tax Group without creating confusion about being the IRS?", ["tax-resolution.1.who_we_are"]),
  ],
});

const DISCOVERY = packet({
  id: "tax-resolution.case-building",
  sectionId: "2",
  directions: ["inbound", "outbound"],
  localObjective: "Build a usable case picture and connect stated tax problems to the prospect's real-life impact.",
  maxTurns: 9,
  criteria: [
    criterion("2", "ask_permission", "Ask permission to gather a few facts so representation fit can be evaluated.", "Cite the learner turn that asks permission before the question sequence."),
    criterion("2", "core_questions", "Determine balance scope, filing gaps, collection activity, and prior help.", "Cite learner turns covering amount/federal-state, unfiled years, notices or enforcement, and prior representation."),
    criterion("2", "pain_points", "Explore how the stated problem affects the prospect's day-to-day life or bottom line and what has already been tried.", "Cite a learner follow-up that responds to the prospect's actual answer instead of merely checking a field."),
    criterion("2", "bridge_to_expert", "Summarize that a clear picture has been built and bridge into relevant guidance.", "Cite the learner turn that closes Discovery without pitching prematurely."),
  ],
  personas: [
    persona("discovery-open", "Concerned and cooperative", "Answers directly but needs the learner to organize the facts.", "foundation"),
    persona("discovery-vague", "Embarrassed and uncertain", "Uses vague answers and reveals useful facts only after careful follow-up.", "intermediate"),
    persona("discovery-combative", "Defensive and questioning", "Asks many questions, gives little back, and tests whether the learner will listen.", "advanced"),
  ],
  situations: [
    "Prospect knows an approximate federal balance but is unsure whether state debt also exists.",
    "Prospect has unfiled years and a recent collection letter but avoids discussing personal impact.",
    "Prospect had a poor prior-firm experience and answers every discovery question with another question.",
  ],
  prohibitedMoves: [
    "quoting a fee",
    "promising a resolution outcome",
    "jumping to the Representation Pitch before core facts are gathered",
    "treating checklist completion as a substitute for listening",
  ],
  reflectionPrompt: "Which answer did you follow up on to uncover real impact rather than merely collecting fields? What important fact was still missing?",
  questions: [
    question("discovery-four-facts", "What four core fact areas must Discovery cover?", ["tax-resolution.2.core_questions"]),
    question("discovery-pain", "What turns a factual tax interview into useful case building?", ["tax-resolution.2.pain_points"]),
  ],
});

const EXPERT_GUIDANCE = packet({
  id: "tax-resolution.expert-guidance",
  sectionId: "3",
  directions: ["inbound", "outbound"],
  localObjective: "Explain the prospect's situation accurately and make verified representation feel more useful than guessing.",
  maxTurns: 7,
  criteria: [
    criterion("3", "three_factors", "Explain that the case turns on what is owed, what is filed, and what the agencies have done on record.", "Cite the learner turn naming all three factors."),
    criterion("3", "name_the_situation", "Apply the script's approved nuance to the prospect's actual levy, lien, filing, business, or mismatch issue.", "Cite the learner explanation tied to the case fact the prospect disclosed."),
    criterion("3", "pain_relief_bridge", "Bridge from uncertainty to the value of working with verified facts and informed decisions.", "Cite the learner turn that provides calm direction without promising a specific outcome."),
  ],
  personas: [
    persona("guidance-confused", "Overwhelmed", "Mixes up liens, levies, and balances and needs a plain explanation.", "foundation"),
    persona("guidance-urgent", "Anxious", "Has active enforcement and presses for an immediate guaranteed fix.", "intermediate"),
    persona("guidance-opinionated", "Certain but misinformed", "Repeats advice from the internet or a prior provider and challenges nuance.", "advanced"),
  ],
  situations: [
    "Prospect thinks a lien means the IRS is taking the house today.",
    "Prospect has wage garnishment and demands assurance it will stop immediately.",
    "Self-employed prospect received mismatch notices and assumes an audit outcome.",
  ],
  prohibitedMoves: [
    "guaranteeing levy or garnishment release",
    "diagnosing a resolution strategy before records are reviewed",
    "reciting unrelated tax facts",
    "moving to price before relevant guidance lands",
  ],
  reflectionPrompt: "Which case fact did you explain with useful nuance? Did you accidentally sound more certain than the verified record allowed?",
  questions: [
    question("guidance-three-factors", "What are the three factors every case comes down to?", ["tax-resolution.3.three_factors"]),
    question("guidance-facts", "Why does the script bridge toward verified facts instead of naming a resolution immediately?", ["tax-resolution.3.pain_relief_bridge"]),
  ],
});

const REPRESENTATION = packet({
  id: "tax-resolution.representation-pitch",
  sectionId: "4",
  directions: ["inbound", "outbound"],
  localObjective: "Present representation as the responsible foundation for verified case work, then state the fee confidently.",
  maxTurns: 10,
  criteria: [
    criterion("4", "three_authorizations", "Present Form 2848, Form 8821, and applicable state POA as the first representation step.", "Cite the learner turn naming the three authorizations."),
    criterion("4", "educate_forms", "Explain each authorization in plain language.", "Cite learner explanations distinguishing communication authority, transcript access, and state authority."),
    criterion("4", "foundation_not_fix", "State that authorization opens access and communication but does not itself change the balance.", "Cite the learner turn explicitly separating foundation from final resolution."),
    criterion("4", "marathon_urgency", "Balance accurate marathon framing with healthy urgency when active communication exists.", "Cite the learner turn that avoids both delay and false immediacy."),
    criterion("4", "differentiate", "Differentiate the firm's verify-first approach without attacking competitors.", "Cite the learner turn contrasting verified facts with big promises."),
    criterion("4", "fee_line", "State the flat representation fee and included work matter-of-factly.", "Cite the learner turn naming the fee and scope without apologizing or discounting."),
  ],
  personas: [
    persona("representation-practical", "Ready for a process explanation", "Wants to know exactly what the initial fee covers.", "foundation"),
    persona("representation-promise-seeker", "Anxious for certainty", "Pushes for a guaranteed settlement before agreeing to representation.", "intermediate"),
    persona("representation-shopper", "Skeptical comparator", "Mentions another company making larger promises and challenges the value.", "advanced"),
  ],
  situations: [
    "Prospect asks why three forms are needed and whether signing them reduces the debt.",
    "Prospect wants the exact resolution before paying for representation.",
    "Prospect says another firm promised pennies on the dollar and asks why this firm will not.",
  ],
  prohibitedMoves: [
    "presenting authorization as the final fix",
    "guaranteeing strategy or outcome",
    "bashing another company",
    "negotiating payment terms before stating the full fee and pausing",
  ],
  reflectionPrompt: "Did your explanation make representation feel concrete without turning it into a promised result? How confidently did you state the fee?",
  questions: [
    question("representation-forms", "What does each authorization permit the firm to do?", ["tax-resolution.4.three_authorizations", "tax-resolution.4.educate_forms"]),
    question("representation-foundation", "What must you say so the prospect understands representation is a foundation, not a fix?", ["tax-resolution.4.foundation_not_fix"]),
  ],
});

const PAYMENT_TERMS = packet({
  id: "tax-resolution.payment-terms",
  sectionId: "4B",
  directions: ["inbound", "outbound"],
  localObjective: "Hold value after the fee, use silence, and walk the approved payment ladder in order.",
  maxTurns: 9,
  criteria: [
    criterion("4B", "state_fee_pause", "State the fee and allow the prospect to react before offering alternatives.", "Cite the fee turn and ensure the next learner turn responds to the prospect rather than pre-discounting."),
    criterion("4B", "anchor_full", "Offer paid in full first and link it to immediate file movement.", "Cite the learner's full-payment anchor."),
    criterion("4B", "two_month_split", "Offer the approved half-now, balance-in-30-days structure only after the full-payment anchor.", "Cite the learner's two-month option in sequence."),
    criterion("4B", "four_month", "Offer four monthly payments with the approved minimum only after earlier options.", "Cite the learner's four-month structure in sequence."),
    criterion("4B", "card_on_file", "Treat card on file as a standard service-agreement step and move to how payment will be made.", "Cite the learner turn that handles card-on-file calmly."),
    criterion("4B", "alt_choice_close", "Close with an alternative choice rather than a yes/no question.", "Cite the learner turn asking which approved structure works."),
  ],
  personas: [
    persona("payment-ready", "Value convinced", "Accepts the fee but waits for a direct payment question.", "foundation"),
    persona("payment-constrained", "Interested but cash-flow sensitive", "Cannot pay in full and requires the ladder one level at a time.", "intermediate"),
    persona("payment-haggler", "Tests confidence", "Calls the fee too high, asks for a discount, and uses silence to make the learner negotiate against themselves.", "advanced"),
  ],
  situations: [
    "Prospect says okay after the fee but the learner must move to payment.",
    "Prospect cannot pay all at once but can handle an approved structure.",
    "Prospect repeatedly asks for the cheapest possible deal before answering which structure works.",
  ],
  prohibitedMoves: [
    "offering payment plans before anchoring full payment",
    "calling a payment structure cheaper or discounting the professional fee",
    "apologizing for the fee",
    "stacking all alternatives before the prospect reacts",
    "ending with a yes/no close",
  ],
  reflectionPrompt: "Did you preserve silence and sequence, or did you negotiate against yourself? Which option did the prospect actually respond to?",
  questions: [
    question("payment-sequence", "What is the required payment-option sequence?", ["tax-resolution.4B.anchor_full", "tax-resolution.4B.two_month_split", "tax-resolution.4B.four_month"]),
    question("payment-close", "Why does the script use an alternative-choice close instead of yes/no?", ["tax-resolution.4B.alt_choice_close"]),
  ],
});

const INFORMATION_COLLECTION = packet({
  id: "tax-resolution.information-collection",
  sectionId: "5",
  directions: ["inbound", "outbound"],
  localObjective: "Move an agreeing prospect into secure file setup without reopening the sale.",
  maxTurns: 7,
  criteria: [
    criterion("5", "start_file", "Clearly transition from agreement into preparing the authorization and agreement.", "Cite the learner turn that begins file setup."),
    criterion("5", "gather_info", "Gather the approved identity, contact, signing, and payment details in a controlled sequence.", "Cite learner turns requesting the required categories without exposing them in feedback."),
    criterion("5", "reassure_security", "Explain secure handling and that the prospect reviews and signs before filing.", "Cite the learner reassurance without making unsupported security claims."),
  ],
  personas: [
    persona("collection-ready", "Committed and organized", "Provides information when asked clearly.", "foundation"),
    persona("collection-cautious", "Privacy conscious", "Pauses at date of birth and SSN and asks why each is needed.", "intermediate"),
    persona("collection-fragmented", "Distracted and disorganized", "Provides partial information out of order and needs calm sequencing.", "advanced"),
  ],
  situations: [
    "Prospect agrees and waits for the learner to begin file setup.",
    "Prospect is willing to sign but hesitates when SSN is requested.",
    "Prospect gives contact details out of order and repeatedly returns to settled price questions.",
  ],
  prohibitedMoves: [
    "collecting SSN before the prospect is ready to sign",
    "repeating sensitive values in feedback or logs",
    "inventing security certifications",
    "reopening resolved objections unnecessarily",
  ],
  reflectionPrompt: "How did you explain why sensitive information was needed while keeping the process calm and secure?",
  questions: [
    question("collection-required", "What information is gathered to prepare the authorization and agreement?", ["tax-resolution.5.gather_info"]),
    question("collection-security", "What should the prospect understand before anything is filed?", ["tax-resolution.5.reassure_security"]),
  ],
});

const THINK_IT_OVER = packet({
  id: "tax-resolution.think-it-over",
  sectionId: "6",
  directions: ["inbound", "outbound"],
  localObjective: "Respond to think-it-over by restoring the value of verified representation and securing a useful next step.",
  maxTurns: 7,
  criteria: [
    criterion("6", "acknowledge_summarize", "Acknowledge the hesitation and summarize representation as access to facts rather than speculation.", "Cite the learner turn that acknowledges before reframing value."),
    criterion("6", "differentiate_no_bash", "Differentiate the firm's represent-first, transcript-backed process without bashing.", "Cite the learner turn that contrasts approaches respectfully."),
    criterion("6", "offer_info_now", "Offer the website or Google reviews at this stage while the prospect reviews the DocuSign.", "Cite the learner turn offering approved company information only after the objection."),
    criterion("6", "soft_followup", "Offer to remain on the line or set a specific later-today follow-up.", "Cite the learner turn that creates a concrete, low-pressure next step."),
  ],
  personas: [
    persona("think-genuine", "Interested but deliberate", "Wants a few minutes to review the agreement and company information.", "foundation"),
    persona("think-brush-off", "Polite but evasive", "Uses think it over to end the call without choosing a next step.", "intermediate"),
    persona("think-burned-before", "Distrustful", "Had a poor prior experience and tests whether the learner will pressure or insult competitors.", "advanced"),
  ],
  situations: [
    "Prospect wants to read the DocuSign before deciding.",
    "Prospect says send me something and I will call you, but refuses a follow-up time.",
    "Prospect cites a prior firm that took money and stopped communicating.",
  ],
  prohibitedMoves: [
    "arguing with the objection",
    "bashing another company",
    "offering reviews before the think-it-over objection arises",
    "ending without an explicit review-on-line or later-today follow-up choice",
  ],
  reflectionPrompt: "Was this genuine consideration or a brush-off? What evidence supports your answer, and what next step did you secure?",
  questions: [
    question("think-value", "What value should be summarized when the prospect says they need to think?", ["tax-resolution.6.acknowledge_summarize"]),
    question("think-followup", "What two soft next steps does the approved script offer?", ["tax-resolution.6.soft_followup"]),
  ],
});

const CLOSING = packet({
  id: "tax-resolution.closing",
  sectionId: "7",
  directions: ["inbound", "outbound"],
  localObjective: "Close the conversation with accurate next steps, reinforced value, and a clean welcome expectation.",
  maxTurns: 5,
  criteria: [
    criterion("7", "summarize_next", "Summarize filing the Limited POA, requesting transcripts, review for accuracy, and the later summary/next steps.", "Cite the learner turn containing the approved operational sequence."),
    criterion("7", "reinforce_value", "Reinforce that representation provides the factual foundation for informed next decisions.", "Cite the learner turn restating value without restarting the pitch."),
    criterion("7", "end_welcome", "Thank the prospect and set the welcome-call and confirmation-email expectation within one business day.", "Cite the learner's final expectation and courteous end."),
  ],
  personas: [
    persona("closing-relieved", "Committed and relieved", "Needs a concise recap and welcome expectation.", "foundation"),
    persona("closing-detail-oriented", "Committed but procedural", "Asks who contacts them and what happens first.", "intermediate"),
    persona("closing-anxious", "Committed but still fearful", "Reopens uncertainty about what the IRS does next and needs a calm factual recap.", "advanced"),
  ],
  situations: [
    "Prospect has completed the agreement and wants to know what happens next.",
    "Prospect asks when the attorney's staff and welcome team will contact them.",
    "Prospect is paid and signed but becomes anxious that nothing will happen.",
  ],
  prohibitedMoves: [
    "promising an unverified case result",
    "inventing a faster timeline",
    "reopening the fee or payment negotiation",
    "ending without the welcome expectation",
  ],
  reflectionPrompt: "Did your close leave the prospect knowing exactly what happens next without promising a result?",
  questions: [
    question("closing-sequence", "What sequence should the final summary describe?", ["tax-resolution.7.summarize_next"]),
    question("closing-expectation", "What communication expectation ends the approved script?", ["tax-resolution.7.end_welcome"]),
  ],
});

const TAX_RESOLUTION_SKILL_PACKETS = Object.freeze([
  INTRODUCTION,
  DISCOVERY,
  EXPERT_GUIDANCE,
  REPRESENTATION,
  PAYMENT_TERMS,
  INFORMATION_COLLECTION,
  THINK_IT_OVER,
  CLOSING,
]);

module.exports = {
  CONTENT_VERSION,
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
};
