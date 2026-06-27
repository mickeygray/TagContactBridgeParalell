"use strict";

// THE TAX GROUP REPRESENTATION SCRIPT — the APPROVED sales methodology (extracted
// from "The Tax Group Representation Script.docx"). This is the BACKBONE of the live
// coach: the coach steers the agent to follow THIS method — the three factors,
// representation-as-foundation (Forms 2848 / 8821 / state POA), the marathon framing,
// the payment ladder (anchor full -> two-month -> four-month $350 -> card on file),
// the tone rules, and the think-it-over handling. Faithful to the approved doc.

const TAX_GROUP_SCRIPT = `THE TAX GROUP — APPROVED REPRESENTATION METHODOLOGY. Coach the agent to follow this:

1. INTRODUCTION
- Inbound: "Thank you for calling The Tax Group, this is [name]. How can I help you today?"
- Outbound: "Your name appeared in public tax records — often a state/federal filing or lien. I'd like to confirm whether you still have an active matter that needs representation. Sound fair?"
- Who we are: a LICENSED TAX REPRESENTATION FIRM — enrolled agents, tax preparers, consultants. Goal: represent you with the IRS/state so you're not left guessing about your records.

2. CASE BUILDING (Discovery + Pain Points)
- "To see if representation makes sense, can I ask a few quick questions?"
- Core questions: about how much is owed (federal/state/both)? any unfiled years? letters about collections, liens, or garnishments? worked with anyone before, or first time?
- PAIN POINTS: as they mention issues, tie each back to their day-to-day life and their bottom line — what steps they've taken, how it worked. Make the tax problem feel like a real personal part of their life, and that you're here to help.
- Bridge: "That gives me a clear picture. Let me explain what we typically see in cases like yours."

3. EXPERT GUIDANCE (show knowledge, add nuance)
- THE THREE FACTORS: "Every tax case comes down to three things — what's owed, what's filed, and what the IRS has already done on record. Until someone represents you, the IRS makes it hard to see the full details."
- Wage garnishment / levy: the IRS flagged the account for enforced collection. Once represented, the attorney's staff reviews the record and what adjustments may be available. Overcoming an active levy/garnishment is difficult, but we review all options immediately and transparently.
- Lien: doesn't seize anything immediately — it secures the IRS/state claim so they're paid first if you sell or liquidate. We verify accuracy and impact once the file is open.
- Unfiled returns: the IRS files substitutes that inflate balances. Representation lets us pull wage & income reports and get you filed correctly.
- Business / payroll taxes: blend business + personal liability; representation separates what's actually yours.
- Capital gains / self-employed / property sales: trigger IRS mismatch notices; once represented we see if it's audit-related, a reporting gap, or unpaid tax.
- PAIN-RELIEF BRIDGE: "The goal is to stop guessing and start working with facts. Once you know exactly what's on record, you can make calm, informed decisions."

4. REPRESENTATION PITCH
- "The first step toward resolving any tax matter is getting you formally represented with the IRS and any state agencies. This involves three authorizations: IRS Form 2848, Form 8821, and the state POA if applicable."
- Educate without jargon: 2848 = limited Power of Attorney (the attorney's staff speak directly with the IRS and receive case info). 8821 = Tax Information Authorization (pull the master file + transcripts to review every balance, filing, and notice). State POA = the same at the state level.
- NOT A FIX, A FOUNDATION: "These forms don't change your balance; they open the door so we can see the facts and communicate lawfully. Once filed, we run a full compliance check and provide follow-up guidance in the first few weeks."
- EXPECTATION + HEALTHY URGENCY: "Tax-debt work is a marathon, not a sprint — each step has to be accurate so the next one means something. Representation is the starting line; until we're inside your file, it's premature to comment on strategy. But if you've had active IRS communication, time matters — the sooner representation is filed, the sooner your legal team engages, and nothing moves forward without review."
- DIFFERENTIATE CALMLY: "A lot of companies rush to big promises. We don't. We take the responsible path — get you represented, gather verified data, then outline real options based on facts."
- FEE LINE (matter-of-fact): "The flat legal fee for representation is $___. That covers preparing and filing the federal + state POA forms, transcript retrieval, and your initial attorney-led compliance review."

4B. PAYMENT TERMS (graceful, firm, professional) — THE CLOSE
- State the fee, then PAUSE. Let them react. If they agree, collect info. If they hesitate ("that's a bit high" / "can't do that all at once"), walk the ladder — ANCHOR FULL FIRST:
  1) Paid in full (ANCHOR): "Most clients take care of this all at once so their file moves immediately — once payment + signed docs are in, the POA is filed and representation activated the same day."
  2) Two-month split: "half today to open the case, the balance in 30 days — still gets your POA filed right away." (A minimum is required to activate the file; the first payment secures the case position.)
  3) Four-month option: "four monthly payments, minimum $350/month, to keep the file moving and in good standing."
  4) Card on file: state the balance, then immediately move to "how will you be paying" — a card on file is standard under the attorney-client service agreement and keeps the case uninterrupted. Make them break it down one level at a time.
  5) Final close (ALTERNATIVE CHOICE, never yes/no): "So the total fee is $___. You can take care of it in full today, or start with two payments or four monthly of $350 — which works best to get representation started today?"
- TONE RULES: confidence first, options second (ALWAYS start from full). Silence is powerful — don't rush to fill the gap after quoting the fee. Frame payments as STRUCTURE, not a discount ("to make it manageable," never "cheaper"). NEVER apologize for the fee — link it to professional value and immediate action. Keep "card on file" casual and standard.

5. INFORMATION COLLECTION
- "Let's get your file started so we can prepare your authorization and agreement."
- Gather: full legal name, address, email & phone, date of birth, SSN (when ready to sign), payment method.
- Reassure: "Everything stays secure under federal privacy rules and IRS Circular 230. You'll review and sign — via DocuSign — before anything is filed."

6. OBJECTION — "I NEED TO THINK IT OVER"
- Acknowledge + summarize: "Representation is what lets the attorney's staff access your records and show you exactly what's happening — no speculation, just facts."
- Differentiate without bashing: "Some companies talk big and deliver little. We're the opposite — represent first, verify with transcripts, explain transparently."
- Offer company info ONLY NOW: "I can text or email our website and Google reviews while you look at the DocuSign — so you see who we are."
- Soft follow-up: "Want me to stay on the line while you review, or check back later today?"

7. CLOSING
- Summarize: "We'll file your Limited POA, request your IRS + state transcripts, and have the attorney's staff review everything for accuracy. Then you get a complete summary and next steps."
- Reinforce value: "Representation is the foundation for anything that follows — knowing exactly where you stand so your next decisions are informed."
- End: "Thank you for getting in front of this. You'll receive your welcome call and confirmation email within one business day."`;

// Structured catalog of the SAME method, for the cockpit SCRIPT column + the deep pull's
// beat-id binding. The client renders each section's beats statically (point + collapsible
// detail) and overlays Opus's per-beat status BY beatId (never fuzzy text). Section ids match
// the prose headings above (1,2,3,4,4B,5,6,7). Kept faithful to TAX_GROUP_SCRIPT; the prose
// string stays byte-identical (it feeds the live model via coachReferenceLibrary) — this is an
// additive parallel view, not a rewrite.
const TAX_GROUP_SECTIONS = [
  {
    id: "1",
    title: "Introduction",
    beats: [
      { id: "inbound_greeting", point: "Inbound greeting", detail: "\"Thank you for calling The Tax Group, this is [name]. How can I help you today?\"" },
      { id: "outbound_opener", point: "Outbound opener", detail: "\"Your name appeared in public tax records — often a state/federal filing or lien. I'd like to confirm whether you still have an active matter that needs representation. Sound fair?\"" },
      { id: "who_we_are", point: "Who we are", detail: "A LICENSED TAX REPRESENTATION FIRM — enrolled agents, tax preparers, consultants. Goal: represent you with the IRS/state so you're not left guessing." },
    ],
  },
  {
    id: "2",
    title: "Case Building (Discovery + Pain Points)",
    beats: [
      { id: "ask_permission", point: "Ask permission to dig in", detail: "\"To see if representation makes sense, can I ask a few quick questions?\"" },
      { id: "core_questions", point: "Core discovery questions", detail: "How much is owed (federal/state/both)? Any unfiled years? Letters about collections, liens, or garnishments? Worked with anyone before, or first time?" },
      { id: "pain_points", point: "Tie pain points to their life", detail: "As they mention issues, tie each back to day-to-day life and bottom line — what they've tried, how it worked. Make the tax problem feel personal; you're here to help." },
      { id: "bridge_to_expert", point: "Bridge to expert guidance", detail: "\"That gives me a clear picture. Let me explain what we typically see in cases like yours.\"" },
    ],
  },
  {
    id: "3",
    title: "Expert Guidance",
    beats: [
      { id: "three_factors", point: "The three factors", detail: "\"Every tax case comes down to three things — what's owed, what's filed, and what the IRS has already done on record. Until someone represents you, the IRS makes it hard to see the full details.\"" },
      { id: "name_the_situation", point: "Name their situation with nuance", detail: "Garnishment/levy = enforced collection (hard to overcome, reviewed immediately). Lien = secures their claim, seizes nothing now. Unfiled = substitutes inflate balances. Business/payroll = blends liability. Cap-gains/self-employed = mismatch notices." },
      { id: "pain_relief_bridge", point: "Pain-relief bridge", detail: "\"The goal is to stop guessing and start working with facts. Once you know exactly what's on record, you can make calm, informed decisions.\"" },
    ],
  },
  {
    id: "4",
    title: "Representation Pitch",
    beats: [
      { id: "three_authorizations", point: "Pitch the three authorizations", detail: "\"The first step is getting you formally represented with the IRS and any state agencies — three authorizations: IRS Form 2848, Form 8821, and the state POA if applicable.\"" },
      { id: "educate_forms", point: "Explain each form plainly", detail: "2848 = limited POA (staff speak directly with the IRS). 8821 = Tax Info Authorization (pull master file + transcripts). State POA = same at the state level." },
      { id: "foundation_not_fix", point: "Foundation, not a fix", detail: "\"These forms don't change your balance; they open the door so we can see the facts and communicate lawfully. Once filed, we run a full compliance check.\"" },
      { id: "marathon_urgency", point: "Marathon + healthy urgency", detail: "\"Tax-debt work is a marathon, not a sprint. Representation is the starting line — but if you've had active IRS communication, the sooner it's filed, the sooner your legal team engages.\"" },
      { id: "differentiate", point: "Differentiate calmly", detail: "\"A lot of companies rush to big promises. We don't. We take the responsible path — get you represented, gather verified data, then outline real options based on facts.\"" },
      { id: "fee_line", point: "State the flat fee, matter-of-fact", detail: "\"The flat legal fee for representation is $___. That covers the federal + state POA forms, transcript retrieval, and your initial attorney-led compliance review.\"" },
    ],
  },
  {
    id: "4B",
    title: "Payment Terms — The Close",
    beats: [
      { id: "state_fee_pause", point: "State the fee, then PAUSE", detail: "State the fee and let them react. Silence is powerful — don't rush to fill the gap." },
      { id: "anchor_full", point: "Anchor paid-in-full first", detail: "\"Most clients take care of this all at once so their file moves immediately — once payment + signed docs are in, the POA is filed and representation activated the same day.\"" },
      { id: "two_month_split", point: "Two-month split", detail: "\"Half today to open the case, the balance in 30 days — still gets your POA filed right away.\" (First payment secures the case position.)" },
      { id: "four_month", point: "Four-month option", detail: "\"Four monthly payments, minimum $350/month, to keep the file moving and in good standing.\"" },
      { id: "card_on_file", point: "Card on file, one level at a time", detail: "State the balance, then move straight to \"how will you be paying?\" — a card on file is standard under the service agreement. Break it down one level at a time." },
      { id: "alt_choice_close", point: "Alternative-choice close (never yes/no)", detail: "\"So the total fee is $___. You can take care of it in full today, or start with two payments or four monthly of $350 — which works best to get representation started today?\"" },
    ],
  },
  {
    id: "5",
    title: "Information Collection",
    beats: [
      { id: "start_file", point: "Start the file", detail: "\"Let's get your file started so we can prepare your authorization and agreement.\"" },
      { id: "gather_info", point: "Gather the details", detail: "Full legal name, address, email & phone, date of birth, SSN (when ready to sign), payment method." },
      { id: "reassure_security", point: "Reassure on security", detail: "\"Everything stays secure under federal privacy rules and IRS Circular 230. You'll review and sign — via DocuSign — before anything is filed.\"" },
    ],
  },
  {
    id: "6",
    title: "Objection — \"I need to think it over\"",
    beats: [
      { id: "acknowledge_summarize", point: "Acknowledge + summarize the value", detail: "\"Representation is what lets the attorney's staff access your records and show you exactly what's happening — no speculation, just facts.\"" },
      { id: "differentiate_no_bash", point: "Differentiate without bashing", detail: "\"Some companies talk big and deliver little. We're the opposite — represent first, verify with transcripts, explain transparently.\"" },
      { id: "offer_info_now", point: "Offer company info ONLY now", detail: "\"I can text or email our website and Google reviews while you look at the DocuSign — so you see who we are.\"" },
      { id: "soft_followup", point: "Soft follow-up", detail: "\"Want me to stay on the line while you review, or check back later today?\"" },
    ],
  },
  {
    id: "7",
    title: "Closing",
    beats: [
      { id: "summarize_next", point: "Summarize the next steps", detail: "\"We'll file your Limited POA, request your IRS + state transcripts, and have the attorney's staff review everything. Then you get a complete summary and next steps.\"" },
      { id: "reinforce_value", point: "Reinforce the value", detail: "\"Representation is the foundation for anything that follows — knowing exactly where you stand so your next decisions are informed.\"" },
      { id: "end_welcome", point: "End on the welcome", detail: "\"Thank you for getting in front of this. You'll receive your welcome call and confirmation email within one business day.\"" },
    ],
  },
];

const SCRIPT_SECTION_IDS = TAX_GROUP_SECTIONS.map((s) => s.id); // ['1','2','3','4','4B','5','6','7']

module.exports = { TAX_GROUP_SCRIPT, TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS };
