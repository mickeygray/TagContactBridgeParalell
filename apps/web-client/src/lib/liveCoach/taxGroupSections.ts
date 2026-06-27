// Client-side mirror of the approved script catalog
// (packages/shared-services/src/taxGroupScript.js -> TAX_GROUP_SECTIONS).
// The cockpit SCRIPT column renders these STATIC beats (point + collapsible detail) and
// overlays the live coach's per-beat status BY beatId. Static reference content; the server
// catalog is the source of truth — tests/live-coach/coachCatalogParity.test.js deep-equals
// BOTH the section ids and every beat id against the server, so drift fails CI.

export type ScriptBeat = { id: string; point: string; detail: string };
export type ScriptSection = { id: string; title: string; beats: ScriptBeat[] };

export const TAX_GROUP_SECTIONS: ScriptSection[] = [
  {
    id: "1",
    title: "Introduction",
    beats: [
      { id: "inbound_greeting", point: "Inbound greeting", detail: "“Thank you for calling The Tax Group, this is [name]. How can I help you today?”" },
      { id: "outbound_opener", point: "Outbound opener", detail: "“Your name appeared in public tax records — often a state/federal filing or lien. I’d like to confirm whether you still have an active matter that needs representation. Sound fair?”" },
      { id: "who_we_are", point: "Who we are", detail: "A LICENSED TAX REPRESENTATION FIRM — enrolled agents, tax preparers, consultants. Goal: represent you with the IRS/state so you’re not left guessing." },
    ],
  },
  {
    id: "2",
    title: "Case building (discovery + pain points)",
    beats: [
      { id: "ask_permission", point: "Ask permission to dig in", detail: "“To see if representation makes sense, can I ask a few quick questions?”" },
      { id: "core_questions", point: "Core discovery questions", detail: "How much is owed (federal/state/both)? Any unfiled years? Letters about collections, liens, or garnishments? Worked with anyone before, or first time?" },
      { id: "pain_points", point: "Tie pain points to their life", detail: "As they mention issues, tie each back to day-to-day life and bottom line — what they’ve tried, how it worked. Make the tax problem feel personal; you’re here to help." },
      { id: "bridge_to_expert", point: "Bridge to expert guidance", detail: "“That gives me a clear picture. Let me explain what we typically see in cases like yours.”" },
    ],
  },
  {
    id: "3",
    title: "Expert guidance",
    beats: [
      { id: "three_factors", point: "The three factors", detail: "“Every tax case comes down to three things — what’s owed, what’s filed, and what the IRS has already done on record. Until someone represents you, the IRS makes it hard to see the full details.”" },
      { id: "name_the_situation", point: "Name their situation with nuance", detail: "Garnishment/levy = enforced collection (hard to overcome, reviewed immediately). Lien = secures their claim, seizes nothing now. Unfiled = substitutes inflate balances. Business/payroll = blends liability. Cap-gains/self-employed = mismatch notices." },
      { id: "pain_relief_bridge", point: "Pain-relief bridge", detail: "“The goal is to stop guessing and start working with facts. Once you know exactly what’s on record, you can make calm, informed decisions.”" },
    ],
  },
  {
    id: "4",
    title: "Representation pitch",
    beats: [
      { id: "three_authorizations", point: "Pitch the three authorizations", detail: "“The first step is getting you formally represented with the IRS and any state agencies — three authorizations: IRS Form 2848, Form 8821, and the state POA if applicable.”" },
      { id: "educate_forms", point: "Explain each form plainly", detail: "2848 = limited POA (staff speak directly with the IRS). 8821 = Tax Info Authorization (pull master file + transcripts). State POA = same at the state level." },
      { id: "foundation_not_fix", point: "Foundation, not a fix", detail: "“These forms don’t change your balance; they open the door so we can see the facts and communicate lawfully. Once filed, we run a full compliance check.”" },
      { id: "marathon_urgency", point: "Marathon + healthy urgency", detail: "“Tax-debt work is a marathon, not a sprint. Representation is the starting line — but if you’ve had active IRS communication, the sooner it’s filed, the sooner your legal team engages.”" },
      { id: "differentiate", point: "Differentiate calmly", detail: "“A lot of companies rush to big promises. We don’t. We take the responsible path — get you represented, gather verified data, then outline real options based on facts.”" },
      { id: "fee_line", point: "State the flat fee, matter-of-fact", detail: "“The flat legal fee for representation is $___. That covers the federal + state POA forms, transcript retrieval, and your initial attorney-led compliance review.”" },
    ],
  },
  {
    id: "4B",
    title: "Payment terms — the close",
    beats: [
      { id: "state_fee_pause", point: "State the fee, then PAUSE", detail: "State the fee and let them react. Silence is powerful — don’t rush to fill the gap." },
      { id: "anchor_full", point: "Anchor paid-in-full first", detail: "“Most clients take care of this all at once so their file moves immediately — once payment + signed docs are in, the POA is filed and representation activated the same day.”" },
      { id: "two_month_split", point: "Two-month split", detail: "“Half today to open the case, the balance in 30 days — still gets your POA filed right away.” (First payment secures the case position.)" },
      { id: "four_month", point: "Four-month option", detail: "“Four monthly payments, minimum $350/month, to keep the file moving and in good standing.”" },
      { id: "card_on_file", point: "Card on file, one level at a time", detail: "State the balance, then move straight to “how will you be paying?” — a card on file is standard under the service agreement. Break it down one level at a time." },
      { id: "alt_choice_close", point: "Alternative-choice close (never yes/no)", detail: "“So the total fee is $___. You can take care of it in full today, or start with two payments or four monthly of $350 — which works best to get representation started today?”" },
    ],
  },
  {
    id: "5",
    title: "Information collection",
    beats: [
      { id: "start_file", point: "Start the file", detail: "“Let’s get your file started so we can prepare your authorization and agreement.”" },
      { id: "gather_info", point: "Gather the details", detail: "Full legal name, address, email & phone, date of birth, SSN (when ready to sign), payment method." },
      { id: "reassure_security", point: "Reassure on security", detail: "“Everything stays secure under federal privacy rules and IRS Circular 230. You’ll review and sign — via DocuSign — before anything is filed.”" },
    ],
  },
  {
    id: "6",
    title: "Objection — “I need to think it over”",
    beats: [
      { id: "acknowledge_summarize", point: "Acknowledge + summarize the value", detail: "“Representation is what lets the attorney’s staff access your records and show you exactly what’s happening — no speculation, just facts.”" },
      { id: "differentiate_no_bash", point: "Differentiate without bashing", detail: "“Some companies talk big and deliver little. We’re the opposite — represent first, verify with transcripts, explain transparently.”" },
      { id: "offer_info_now", point: "Offer company info ONLY now", detail: "“I can text or email our website and Google reviews while you look at the DocuSign — so you see who we are.”" },
      { id: "soft_followup", point: "Soft follow-up", detail: "“Want me to stay on the line while you review, or check back later today?”" },
    ],
  },
  {
    id: "7",
    title: "Closing",
    beats: [
      { id: "summarize_next", point: "Summarize the next steps", detail: "“We’ll file your Limited POA, request your IRS + state transcripts, and have the attorney’s staff review everything. Then you get a complete summary and next steps.”" },
      { id: "reinforce_value", point: "Reinforce the value", detail: "“Representation is the foundation for anything that follows — knowing exactly where you stand so your next decisions are informed.”" },
      { id: "end_welcome", point: "End on the welcome", detail: "“Thank you for getting in front of this. You’ll receive your welcome call and confirmation email within one business day.”" },
    ],
  },
];

export const SCRIPT_SECTION_IDS: string[] = TAX_GROUP_SECTIONS.map((s) => s.id);

export function getScriptSection(id: string | null | undefined): ScriptSection | null {
  if (!id) return null;
  return TAX_GROUP_SECTIONS.find((s) => s.id === id) || null;
}

// Resolve the section that owns a beat — lets the cockpit recover the SCRIPT column when the
// model emits an off-enum currentSection (clamped to null server-side) but valid beat ids.
export function getScriptSectionForBeat(beatId: string | null | undefined): ScriptSection | null {
  if (!beatId) return null;
  return TAX_GROUP_SECTIONS.find((s) => s.beats.some((b) => b.id === beatId)) || null;
}
