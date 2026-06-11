"use strict";

const contextMatchBank = require("./liveCoachContextMatchBank");

const VOICEMAIL_MATCHES = [
  "name and number",
  "can't take your call now",
  "cant take your call now",
  "not able to get with you right now",
  "not able to get to you right now",
  "not able to take your call",
  "we are not available now",
  "we're not available now",
  "not available now",
  "this person is not available",
  "person is not available",
  "person you're trying to reach is not available",
  "person you are trying to reach is not available",
  "didn't get your message",
  "did not get your message",
  "not speaking or because of a bad connection",
  "if you're satisfied with the message",
  "if you are satisfied with the message",
  "to erase and re-record",
  "to erase and rerecord",
  "at the tone",
  "after the tone",
  "forwarded to voicemail",
  "forwarded to an automated voice messaging system",
  "forwarded to an automatic voice message system",
  "automatic voice message system",
  "automatic voice messaging system",
  "leave a message",
  "leave your message",
  "leave me a message",
  "record a message",
  "please record your message",
  "record your message",
  "voice mailbox",
  "voicemail box",
  "mailbox is full",
  "automated voice messaging system",
  // Mined from real floor transcripts (2026-06-10): greeting/system phrasings
  // the gate was missing while the call kept transcribing to the bitter end.
  "unable to come to the phone",
  "can't come to the phone",
  "cannot come to the phone",
  "can't get to the phone",
  "cannot get to the phone",
  "press the pound key",
  "hang up or press",
  "is not in service",
  "check the number and dial again",
  "has not been set up yet",
  "try your call again later",
  // Contraction greeting forms (live miss 2026-06-10: real carrier greeting
  // "This is Nicki, I'm not available, bye." — the patterns only knew
  // "i am" / "this person is"). Start-only gate, so a live human's first
  // utterance is "Hello?", not these.
  "i'm not available",
  "i am not available",
  "we're not available",
  // Spanish voicemail prompts (STT transcribes them faithfully; the gate
  // never spoke Spanish). Include unaccented variants for STT drift.
  "buzón de voz",
  "buzon de voz",
  "graba tu mensaje",
  "grabe su mensaje",
  "después del tono",
  "despues del tono",
  "deja tu mensaje",
  "deje su mensaje",
];

// Unambiguous MACHINE audio that can never be a live prospect speaking —
// voicemail deposit menus, carrier intercepts, forward announcements. Unlike
// VOICEMAIL_MATCHES (checked only before the first coachable turn), these
// reject the session at ANY point: a missed greeting or a stray early fragment
// used to disable the gate and the bridge then transcribed the entire
// voicemail deposit (menus included) for nothing.
const VOICEMAIL_ANYTIME_MATCHES = [
  "satisfied with the message, press",
  "if you're satisfied with the message",
  "if you are satisfied with the message",
  "to erase and re-record",
  "to erase and rerecord",
  "to listen to your message, press",
  "continue recording where you left off",
  "has been forwarded to voicemail",
  "forwarded to an automated voice messaging system",
  "forwarded to an automatic voice message system",
  "automatic voice message system",
  "at the tone, please record your message",
  "when you have finished recording",
  "is not in service",
  "buzón de voz",
  "buzon de voz",
];

const VOICEMAIL_PATTERNS = [
  {
    label: "leave a message",
    pattern: /\bleave\s+(?:(?:me|us|a|your)\s+){0,2}(?:(?:quick|brief|short|detailed|voice)\s+)?message\b/i,
  },
  {
    label: "leave your name and number",
    pattern: /\b(?:please\s+)?leave\s+(?:your\s+)?name\s+(?:and|&)\s+(?:phone\s+)?number\b/i,
  },
  {
    label: "unavailable leave name and number",
    pattern: /\b(?:not\s+able|unable|unavailable|not\s+available)\b.{0,140}\b(?:leave|record)\b.{0,80}\b(?:name|number|message)\b/i,
  },
  {
    label: "not available now",
    pattern: /\b(?:(?:we|i|this\s+person|the\s+person)\s+(?:are|am|is)|person\s+(?:you're|you\s+are)\s+trying\s+to\s+reach\s+is)\b.{0,80}\b(?:not\s+available|unavailable)(?:\s+now)?\b/i,
  },
  {
    label: "post-message voicemail menu",
    pattern: /\b(?:satisfied\s+with\s+the\s+message|listen\s+to\s+your\s+message|erase\s+and\s+re-?record|continue\s+recording|press\s+(?:one|1|two|2|three|3|pound))\b.{0,160}\b(?:message|recording|options?)\b/i,
  },
  {
    label: "no voicemail audio captured",
    pattern: /\b(?:didn['’]?t|did\s+not)\s+get\s+your\s+message\b.{0,140}\b(?:not\s+speaking|bad\s+connection|record\s+your\s+message|press\s+2)\b/i,
  },
  {
    label: "record your message",
    pattern: /\b(?:record|leave)\s+(?:your\s+)?message\s+(?:after|at)\s+the\s+tone\b/i,
  },
  {
    label: "not available leave a message",
    pattern: /\b(?:not|un)available\b.{0,120}\b(?:leave|record)\b.{0,80}\bmessage\b/i,
  },
  {
    label: "forwarded to voicemail",
    pattern: /\b(?:call|your call)\b.{0,80}\bforwarded\b.{0,80}\b(?:voicemail|voice\s+mail|voice\s+messaging)\b/i,
  },
  {
    label: "voicemail greeting",
    pattern: /\b(?:voicemail|voice\s+mail|mailbox)\b.{0,120}\b(?:message|tone|full|unavailable)\b/i,
  },
  {
    // "Not available. Bye." / "not available right now, thanks, bye" — terse
    // carrier/personal greetings that end in a goodbye instead of instructions.
    label: "not available goodbye",
    pattern: /\bnot\s+available\b[\s.,!]*(?:right\s+now\b[\s.,!]*)?(?:bye|goodbye|thanks)\b/i,
  },
  {
    // Garbled-greeting fragment: custom greetings transcribe patchily and the
    // surviving final can be as thin as "available by(e)". Start-only gate, and
    // a live human's first utterance never ENDS in "available bye" — anchored
    // to the end of the fragment to keep it tight.
    label: "available goodbye fragment",
    pattern: /\bavailable\b[\s.,!]*(?:bye|by)\b[\s.,!]*$/i,
  },
];

const CALL_SCREENER_MATCHES = [
  "ai assistant",
  "call assistant",
  "virtual assistant",
  "automated assistant",
  "recording this call",
  "record your name",
  "name and reason for calling",
  "reason for calling",
  "what is this regarding",
  "who may i say is calling",
  "can i tell them who's calling",
  "can i tell them whos calling",
  "i'll see if this person is available",
  "ill see if this person is available",
  "let me see if",
  "one moment",
  "hold please",
  "may i ask who's calling",
  "may i ask whos calling",
  "who is calling",
  "who's calling",
];

const SYSTEM_CONTEXT_CLEAR_MATCHES = [
  "please stay on the line",
  "stay on the line",
  "please continue to hold",
  "continue to hold",
];

const FILLER_PATTERNS = [
  /^(yeah|yes|no|okay|ok|right|sure|uh|um|hello|hi|thanks|thank you)[.!?]?$/i,
  /^(mm+h?m*|mhm|hmm)[.!?]?$/i,
];

const CONTEXT_RULES = [
  {
    key: "legitimacy",
    label: "Opening legitimacy",
    family: "sales",
    priority: 70,
    keywords: [
      "who are you",
      "why are you calling",
      "how did you get",
      "scam",
      "legit",
      "legitimate",
      "company",
      "public records",
      "is this real",
      "are you real",
      "is this spam",
      "spam call",
      "robo call",
      "where did you get my number",
      "how did you get my number",
      "why did i get this call",
      "do i know you",
      "who is this",
      "what company",
      "tax advocate",
      "tax group",
      "public record",
      "tax lien record",
    ],
    guidance:
      "Self-identify clearly, tie the call to their tax inquiry/public tax signal, and ask permission to verify the issue.",
  },
  {
    key: "irs_notice",
    label: "IRS notice",
    family: "tax_comprehension",
    priority: 100,
    keywords: [
      "IRS",
      "CP501",
      "CP503",
      "CP504",
      "CP2000",
      "CP50",
      "LT11",
      "Letter 1058",
      "notice",
      "letter",
      "federal",
      "transcript",
      "internal revenue",
      "department of treasury",
      "irs letter",
      "federal tax",
      "tax bill",
      "balance due",
      "amount due",
      "certified mail",
      "certified letter",
      "notice of intent",
      "intent to levy",
      "cp notice",
      "letter 11",
      "letter eleven",
      "notice 1058",
      "final letter",
      "tax year",
      "tax years",
    ],
    guidance:
      "Treat this as likely IRS/federal unless a clear state agency is named; ask notice type, year, amount, and deadline before naming options.",
  },
  {
    key: "state_tax",
    label: "State tax",
    family: "tax_comprehension",
    priority: 95,
    keywords: [
      "state",
      "FTB",
      "EDD",
      "franchise tax",
      "sales tax",
      "state lien",
      "state levy",
      "state garnishment",
      "franchise tax board",
      "department of revenue",
      "department of taxation",
      "state tax board",
      "state notice",
      "state letter",
      "state balance",
      "california tax",
      "california state",
      "state agency",
      "state income tax",
      "state collections",
    ],
    guidance:
      "Separate state symptoms from federal symptoms and screen for whether there is also an IRS/federal balance or unfiled return issue.",
  },
  {
    key: "collection_pressure",
    label: "Collection pressure",
    family: "tax_comprehension",
    priority: 95,
    keywords: [
      "levy",
      "lien",
      "garnish",
      "garnishment",
      "bank account",
      "freeze",
      "frozen",
      "paycheck",
      "revenue officer",
      "collections",
      "final notice",
      "take my wages",
      "take my paycheck",
      "take my check",
      "take money",
      "took money",
      "bank levy",
      "wage levy",
      "wage garnishment",
      "levied",
      "garnished",
      "seize",
      "seizure",
      "freeze my account",
      "locked my account",
      "empty my account",
      "property lien",
      "tax lien",
      "filed a lien",
      "filed lien",
      "threaten",
      "threatening",
      "collection notice",
      "levy notice",
    ],
    guidance:
      "Acknowledge urgency, confirm whether money is being taken now, then move toward representation and fact gathering without promising a stop.",
  },
  {
    key: "unfiled_returns",
    label: "Unfiled returns",
    family: "tax_comprehension",
    priority: 90,
    keywords: [
      "unfiled",
      "haven't filed",
      "havent filed",
      "hasn't filed",
      "didn't file",
      "missing return",
      "years behind",
      "substitute for return",
      "SFR",
      "back taxes",
      "tax returns",
      "late return",
      "late returns",
      "not file",
      "did not file",
      "didn't do my taxes",
      "didnt do my taxes",
      "haven't done taxes",
      "havent done taxes",
      "haven't done my taxes",
      "havent done my taxes",
      "years missing",
      "returns missing",
      "filing behind",
      "behind on filing",
    ],
    guidance:
      "Find the missing years and income type; frame cleanup as a first step before anyone guesses at resolution.",
  },
  {
    key: "payroll_tax",
    label: "Payroll tax",
    family: "tax_comprehension",
    priority: 90,
    keywords: [
      "payroll",
      "941",
      "940",
      "trust fund",
      "TFRP",
      "employee withholding",
      "withholding",
      "business tax",
      "employees",
      "employment tax",
      "941s",
      "quarterlies",
      "quarterly payroll",
      "payroll returns",
      "pay employees",
      "withheld from employees",
      "responsible person",
      "responsible-person",
      "business owes",
      "business taxes",
      "business balance",
      "trust fund recovery",
      "employee taxes",
    ],
    guidance:
      "Separate business and personal exposure; ask quarters/years, whether the business is operating, and whether trust fund/responsible-person language appeared.",
  },
  {
    key: "self_employment",
    label: "1099 / self-employment",
    family: "tax_comprehension",
    priority: 85,
    keywords: [
      "1099",
      "1099-NEC",
      "contractor",
      "independent contractor",
      "self-employed",
      "self employed",
      "Schedule C",
      "gig",
      "quarterly",
      "estimated tax",
      "1099K",
      "1099-K",
      "venmo",
      "paypal",
      "etsy",
      "cash app",
      "cashapp",
      "doordash",
      "uber",
      "lyft",
      "side hustle",
      "gig work",
      "freelance",
      "freelancer",
      "no withholding",
      "did not withhold",
      "didn't withhold",
      "write off",
      "write-off",
      "business expenses",
      "mileage",
    ],
    guidance:
      "Explain that withholding may not have happened; ask years, income records, and whether expenses were ever counted.",
  },
  {
    key: "audit_adjustment",
    label: "Audit or adjustment",
    family: "tax_comprehension",
    priority: 80,
    keywords: [
      "audit",
      "exam",
      "examination",
      "underreporter",
      "missing income",
      "adjustment",
      "proposed assessment",
      "receipts",
      "audited",
      "being audited",
      "tax court",
      "irs changed",
      "they changed my return",
      "changed my return",
      "disallowed",
      "deductions",
      "proof",
      "prove",
      "1099 mismatch",
      "w2 mismatch",
      "income mismatch",
      "computer matching",
      "notice of deficiency",
      "90 day letter",
      "ninety day letter",
    ],
    guidance:
      "Identify whether this is an exam, underreporter, or balance after assessment; ask what document or deadline they received.",
  },
  {
    key: "spouse_identity",
    label: "Spouse or identity issue",
    family: "tax_comprehension",
    priority: 75,
    keywords: [
      "spouse",
      "ex spouse",
      "ex-spouse",
      "divorce",
      "joint",
      "innocent spouse",
      "injured spouse",
      "identity theft",
      "stolen identity",
      "wife",
      "husband",
      "ex wife",
      "ex-wife",
      "ex husband",
      "ex-husband",
      "married filing joint",
      "filed jointly",
      "separated",
      "separation",
      "my ex",
      "not my income",
      "not my debt",
      "refund taken",
      "offset",
    ],
    guidance:
      "Do not decide liability on the call; ask filing status, years, and whether the notice names both spouses.",
  },
  {
    key: "money_pressure",
    label: "Money pressure",
    family: "human_context",
    priority: 70,
    keywords: [
      "can't afford",
      "cant afford",
      "paycheck",
      "my check",
      "rent",
      "mortgage",
      "car payment",
      "bills",
      "kids",
      "food",
      "bank account",
      "business cash flow",
      "lost my job",
      "laid off",
      "fixed income",
      "social security",
      "retired",
      "medical bills",
      "hospital",
      "child support",
      "single parent",
      "utilities",
      "groceries",
      "food bill",
      "can't pay",
      "cant pay",
      "take money out",
      "money out of my check",
      "out of my check",
      "no money",
      "broke",
      "pay rent",
      "make rent",
    ],
    guidance:
      "Give one human acknowledgment, then ask a concrete financial or enforcement fact that moves the call forward.",
  },
  {
    key: "emotional_pressure",
    label: "Emotional pressure",
    family: "human_context",
    priority: 70,
    keywords: [
      "scared",
      "scary",
      "afraid",
      "nervous",
      "stress",
      "stressed",
      "worried",
      "confused",
      "embarrassed",
      "can't sleep",
      "cant sleep",
      "overwhelmed",
      "frustrated",
      "panic",
      "panicking",
      "freaking out",
      "anxious",
      "anxiety",
      "upset",
      "mad",
      "angry",
      "lost",
      "don't understand",
      "dont understand",
      "no idea",
      "terrified",
      "humiliated",
      "ashamed",
    ],
    guidance:
      "Sound human first, avoid therapy language, and ask the next fact needed to regain control.",
  },
  {
    key: "objection",
    label: "Objection or resistance",
    family: "sales",
    priority: 75,
    keywords: [
      "not interested",
      "busy",
      "call me back",
      "already handled",
      "taken care of",
      "accountant",
      "expensive",
      "think about it",
      "spouse",
      "send me",
      "email me",
      "mail me",
      "just send",
      "already have someone",
      "have a lawyer",
      "have an attorney",
      "have a CPA",
      "my CPA",
      "tax person",
      "accountant handles",
      "not right now",
      "bad time",
      "later",
      "take me off",
      "stop calling",
      "do not call",
      "don't call",
      "dont call",
      "remove me",
      "not my problem",
    ],
    guidance:
      "Lower pressure, clarify the objection, and return to why reviewing the facts matters before guessing.",
  },
  {
    key: "representation",
    label: "Representation / POA",
    family: "sales",
    priority: 75,
    keywords: [
      "represent",
      "representation",
      "power of attorney",
      "POA",
      "2848",
      "8821",
      "authorization",
      "talk to the IRS",
      "handle this",
      "speak for me",
      "speak to the IRS",
      "call the IRS",
      "deal with the IRS",
      "deal with them",
      "take over",
      "authorized",
      "authorization form",
      "transcript pull",
      "pull transcripts",
      "talk to them",
      "contact them",
      "on my behalf",
      "representative",
    ],
    guidance:
      "Frame representation as the foundation for fact gathering and agency communication, not as a magic resolution.",
  },
  {
    key: "fees_close",
    label: "Fees / close",
    family: "sales",
    priority: 65,
    keywords: [
      "cost",
      "costs",
      "fee",
      "fees",
      "price",
      "pricing",
      "how much",
      "what this costs",
      "what it costs",
      "what does it cost",
      "what do you charge",
      "charge",
      "payment",
      "card",
      "monthly",
      "today",
      "sign",
      "retainer",
      "down payment",
      "deposit",
      "credit card",
      "debit card",
      "bank draft",
      "ACH",
      "pay today",
      "start today",
      "enroll",
      "enrollment",
      "agreement",
      "paperwork",
      "contract",
      "afford",
      "expensive",
      "cheap",
      "too much",
      "worth it",
    ],
    guidance:
      "State value and scope confidently only after enough facts; do not apologize for price or over-explain.",
  },
];

const COMPLETE_THOUGHT_TRIGGERS = [
  "IRS",
  "CP",
  "LT11",
  "Letter 1058",
  "notice",
  "letter",
  "levy",
  "lien",
  "garnish",
  "payroll",
  "1099",
  "unfiled",
  "state",
  "FTB",
  "EDD",
  "owe",
  "balance",
  "scared",
  "worried",
  "stressed",
  "can't afford",
  "cant afford",
  "not interested",
  "who are you",
  "why are you calling",
  "cost",
  "fee",
];

const WEAK_CONTEXT_HITS = new Set([
  "notice",
  "letter",
  "state",
  "company",
  "paycheck",
  "my check",
  "spouse",
  "payment",
  "card",
  "today",
  "sign",
  "paperwork",
  "talk to them",
  "handle this",
  "contact them",
]);

const TACTIC_RULES = [
  {
    key: "calm_urgency",
    label: "Calm urgency",
    family: "psychology",
    priority: 100,
    applies: ({ keys }) => keys.has("collection_pressure"),
    guidance:
      "Lead with calm urgency, not alarm. Acknowledge the risk, confirm whether enforcement is active, then move into fact-gathering and representation without promising a stop.",
    humor:
      "No humor when levy, garnishment, liens, frozen accounts, or wage pressure are in play.",
  },
  {
    key: "human_reassurance",
    label: "Human reassurance",
    family: "psychology",
    priority: 95,
    applies: ({ keys, text }) =>
      keys.has("emotional_pressure") ||
      keys.has("money_pressure") ||
      /\b(scared|worried|stressed|panic|overwhelmed|can't sleep|cant sleep|rent|kids|medical|lost my job|laid off)\b/i.test(text),
    guidance:
      "Mirror the life pressure in plain language first, then ask one concrete control question. Avoid therapy language, lectures, or rushing straight to price.",
    humor:
      "Use warmth, not jokes. If they are scared or broke, cleverness will sound dismissive.",
  },
  {
    key: "permission_legitimacy",
    label: "Permission and legitimacy",
    family: "sales_psychology",
    priority: 90,
    applies: ({ keys }) => keys.has("legitimacy"),
    guidance:
      "Slow the call down, identify the agent and firm, connect the call to the tax signal, and ask permission to verify the issue before pitching.",
    humor:
      "No jokes until legitimacy is restored; clarity beats charm here.",
  },
  {
    key: "lower_pressure_objection",
    label: "Lower pressure objection handling",
    family: "sales_psychology",
    priority: 88,
    applies: ({ keys }) => keys.has("objection"),
    guidance:
      "Respect the resistance, lower pressure, and ask for one useful fact or permission to explain why the review matters before ending the call.",
    humor:
      "A tiny softener is acceptable only if the objection is mild; never joke around DNC, anger, or distrust.",
  },
  {
    key: "confident_value_frame",
    label: "Confident value frame",
    family: "sales_psychology",
    priority: 82,
    applies: ({ keys }) => keys.has("fees_close"),
    guidance:
      "Answer price pressure with confidence and scope. Tie cost to investigation, representation, and cleanup; do not apologize, discount, or over-explain.",
    humor:
      "Keep humor out of fee pressure unless rapport is already obvious.",
  },
  {
    key: "expert_specificity",
    label: "Expert specificity",
    family: "sales_psychology",
    priority: 78,
    applies: ({ keys }) =>
      keys.has("payroll_tax") ||
      keys.has("self_employment") ||
      keys.has("audit_adjustment") ||
      keys.has("spouse_identity"),
    guidance:
      "Sound specialized by naming the next fact that matters. Use tax comprehension to prove expertise, then pivot to why the team needs documents/authorization.",
    humor:
      "Avoid jokes about complex or embarrassing facts; confidence should carry the warmth.",
  },
  {
    key: "shame_reduction",
    label: "Shame reduction",
    family: "psychology",
    priority: 76,
    applies: ({ keys, text }) =>
      keys.has("unfiled_returns") ||
      keys.has("spouse_identity") ||
      /\b(embarrassed|ashamed|humiliated|my fault|i messed up|years behind|haven't filed|havent filed)\b/i.test(text),
    guidance:
      "Normalize without excusing. Make it feel sortable: years, income type, notices, then representation/fact review.",
    humor:
      "Gentle warmth is okay; do not make the person feel like the joke is about them.",
  },
  {
    key: "state_to_irs_screen",
    label: "State-to-IRS screen",
    family: "sales_psychology",
    priority: 74,
    applies: ({ keys, jurisdiction }) => keys.has("state_tax") || jurisdiction === "state" || jurisdiction === "mixed",
    guidance:
      "Do not over-anchor on state-only help. Separate state symptoms from IRS symptoms and screen for federal balances or unfiled years where the larger resolution value usually lives.",
    humor:
      "Keep it practical; state/federal confusion needs clarity more than personality.",
  },
  {
    key: "next_phase_control",
    label: "Next phase control",
    family: "sales_psychology",
    priority: 65,
    applies: ({ keys }) => keys.size > 0,
    guidance:
      "Move the call one phase forward: identify issue, discover pain, prove expertise, then gather facts. Do not solve the case inside the one-liner.",
    humor:
      "Only use light conversational warmth when the prospect is calm and there is no enforcement, shame, fee, or legitimacy pressure.",
  },
  {
    key: "light_warmth_allowed",
    label: "Light warmth allowed",
    family: "humor",
    priority: 35,
    applies: ({ keys, text }) =>
      !keys.has("collection_pressure") &&
      !keys.has("emotional_pressure") &&
      !keys.has("money_pressure") &&
      !keys.has("fees_close") &&
      !keys.has("legitimacy") &&
      !keys.has("objection") &&
      /\b(taxes are|taxes is|this is a mess|what a mess|confusing|ridiculous|crazy|i hate taxes)\b/i.test(text),
    guidance:
      "A brief human softener can make the agent sound alive, but it must immediately pivot to the next useful fact.",
    humor:
      "Dry, low-stakes warmth only. Never make tax enforcement, debt, fear, or the prospect themselves the joke.",
  },
  {
    key: "anchor_to_inquiry",
    label: "Re-anchor to the inquiry",
    family: "sales_psychology",
    priority: 99,
    applies: ({ text }) =>
      /\b(didn'?t ask|never asked|don'?t know what (you'?re|your|you are) talking|what (is )?this (is )?about|didn'?t (request|sign up)|why would i|never (filled|signed)|no idea what|i didn'?t do anything)\b/i.test(text),
    guidance:
      "They forgot the inquiry or are testing you. Do not get apologetic or over-explain the lead source. Re-anchor with quiet authority to the one thing that matters and pivot straight to the diagnostic: 'You submitted an inquiry about a tax issue, and I can actually help with that — do you owe the IRS, or not?' Certainty disarms; pleading does not.",
    humor:
      "No humor — they are skeptical. Calm certainty is the disarmer, not cleverness.",
  },
  {
    key: "hostility_resilience",
    label: "Hostility resilience",
    family: "psychology",
    priority: 98,
    applies: ({ text }) =>
      /\b(f[\W_]*you|f off|leave me alone|stop calling|go away|piss off|screw you|how dare|harass|quit calling|don'?t call|get a life|loser)\b/i.test(text),
    guidance:
      "A hostile tone is a defense, not a final answer — people answering an unknown tax call are often scared or embarrassed. Do not apologize repeatedly, do not flinch, do not match their heat. Stay flat and steady, acknowledge once, and make ONE clean attempt to land the value: 'Understood, not trying to bother you. You did reach out about a tax issue, and that part is fixable — do you owe the IRS, or not?' If they give a genuine, unambiguous stop/do-not-call, honor it and disengage.",
    humor:
      "Absolutely none — humor here reads as mockery and confirms their worst assumption.",
  },
  {
    key: "loop_in_decision_maker",
    label: "Loop in the decision maker",
    family: "sales_psychology",
    priority: 70,
    applies: ({ text }) =>
      /\b(my (husband|wife|spouse|partner|accountant)|talk to my|ask my|both of us|joint (return|filing|taxes)|we file (jointly|together)|have to (ask|check with)|run it by)\b/i.test(text),
    guidance:
      "Do not lose the call to 'I have to ask someone.' Affirm that involving the spouse/partner is smart, then keep momentum by gathering facts now so that conversation is informed: 'Smart to keep them in the loop — so when you two talk you have the real picture, what notice and year are we looking at?' Never imply they can't decide alone.",
    humor:
      "Light warmth fine if calm; never joke about the relationship or their authority to decide.",
  },
  {
    key: "dissolve_stall",
    label: "Dissolve the stall",
    family: "sales_psychology",
    priority: 68,
    applies: ({ text }) =>
      /\b(think about it|call me back|call back later|send me (something|info|details|an email)|email me|not a good time|busy right now|let me think|maybe later|in writing|some other time)\b/i.test(text),
    guidance:
      "A stall usually hides a real concern — cost, trust, or 'is this even worth it.' Use LAER: acknowledge, then explore the real hesitation: 'Happy to follow up — so I send the right thing, is the hesitation the cost, or whether this is legit?' Tax balances compound, so tie waiting to growing penalties gently, without pressure.",
    humor:
      "A very dry softener is okay on a mild stall; never on a hard no or when money pressure is present.",
  },
  {
    key: "already_represented",
    label: "Already has help",
    family: "sales_psychology",
    priority: 66,
    applies: ({ text }) =>
      /\b(already have (a|an|someone)|i have a (cpa|accountant|attorney|lawyer|tax (guy|person|preparer))|working with (someone|a (firm|company))|someone is handling|another company|my guy|my accountant)\b/i.test(text),
    guidance:
      "Never disparage the other party. Separate filing from resolution: a CPA who prepares returns is not the same as active IRS representation negotiating collections. Screen whether it's actually resolved: 'Good that you have someone — are they actively representing you on the collection side, or just preparing returns? Those are different jobs.'",
    humor:
      "Keep it professional; no jokes at the other provider's expense.",
  },
  {
    key: "earn_trust_with_proof",
    label: "Earn trust with proof",
    family: "psychology",
    priority: 64,
    applies: ({ keys, text }) =>
      !keys.has("legitimacy") &&
      /\b(scam|you people|all the same|how do i (know|trust)|trust you|rip ?off|prove it|skeptical|don'?t trust|too good to be true|sounds like a scam)\b/i.test(text),
    guidance:
      "Distrust beyond a simple 'who are you' needs proof, not persuasion. Be specific and verifiable — name the firm, the concrete process (investigation, authorization via 2848, representation), and invite them to verify it independently. Drop all pressure; specifics and calm beat reassurance.",
    humor:
      "No humor; a skeptical person reads jokes as deflection.",
  },
  {
    key: "channel_relief",
    label: "Channel relief into action",
    family: "psychology",
    priority: 60,
    applies: ({ text }) =>
      /\b(thank god|finally|so glad|relieved|can you (really|actually) help|you can help|that would be (great|amazing)|i need help|please help|don'?t know what to do)\b/i.test(text),
    guidance:
      "Hope is fragile — do not over-promise and break it. Channel relief into the immediate next concrete step without guaranteeing outcomes: 'We help people through exactly this every day. To get you the real answer instead of a guess, let's start with the notice and the year you're looking at.'",
    humor:
      "Warmth yes, jokes no — they're being vulnerable; meet it sincerely.",
  },
];

function cleanText(value, maxLength = 6000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (["agent", "prospect", "system", "unknown"].includes(role)) return role;
  if (["client", "customer", "callee", "remote"].includes(role)) return "prospect";
  return "prospect";
}

function normalizeTaxTerms(text) {
  let output = cleanText(text, 6000);
  output = output.replace(/\bc\s*p\s*[- ]?\s*(\d{3,4})\b/gi, (_m, number) => `CP${number}`);
  output = output.replace(/\bcp\s*[- ]?\s*(\d{3,4})\b/gi, (_m, number) => `CP${number}`);
  output = output.replace(/\bl\s*t\s*[- ]?\s*(\d{2})\b/gi, (_m, number) => `LT${number}`);
  output = output.replace(/\bletter\s+ten\s+fifty\s+eight\b/gi, "Letter 1058");
  output = output.replace(/\bi\s*r\s*s\b/gi, "IRS");
  output = output.replace(/\bf\s*t\s*b\b/gi, "FTB");
  output = output.replace(/\be\s*d\s*d\b/gi, "EDD");
  output = output.replace(/\bten\s+ninety\s+nine\b/gi, "1099");
  output = output.replace(/\bw\s*[- ]?\s*2\b/gi, "W-2");
  output = output.replace(/\bform\s+nine\s+forty\s+one\b/gi, "Form 941");
  output = output.replace(/\bform\s+nine\s+forty\b/gi, "Form 940");
  return output;
}

function normalizeSttTranscript(input = {}) {
  const text = normalizeTaxTerms(input.text || input.transcript || input.finalText || "");
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  return {
    id: cleanText(input.id || "", 120) || null,
    at: cleanText(input.at || "", 80) || new Date().toISOString(),
    role: normalizeRole(input.role || input.speaker),
    text,
    itemId: cleanText(input.itemId || input.item_id || "", 120) || null,
    source: cleanText(input.source || "stt", 80),
    provider: cleanText(input.provider || input.sttProvider || "", 80) || null,
    model: cleanText(input.model || input.sttModel || "", 120) || null,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
    // Marked-not-dropped: the bridge delivers low-logprob finals with this
    // flag instead of discarding them. UI grays the row; models see the flag.
    lowConfidence: Boolean(input.lowConfidence),
    // Primer echo: the bridge flagged this final as mostly primer vocabulary
    // (the STT prompt hallucinated over noise/silence). Never coachable.
    primerEcho: Boolean(input.primerEcho),
    // Dual-VAD channel: "fast" = server_vad quick finals (additive context,
    // never composes), "turn" = semantic_vad completed thoughts (Claude's
    // trigger). Empty = single-channel legacy.
    channel: cleanText(input.channel || "", 20) || null,
    isFinal: input.isFinal === undefined ? true : Boolean(input.isFinal),
    durationSec: Number.isFinite(Number(input.durationSec)) ? Number(input.durationSec) : null,
    wordCount: words.length,
  };
}

function includesPhrase(text, phrases) {
  const lower = cleanText(text, 6000).toLowerCase();
  return phrases.find((phrase) => lower.includes(String(phrase).toLowerCase())) || null;
}

function includesPattern(text, patterns) {
  const clean = cleanText(text, 6000);
  for (const row of patterns) {
    if (row.pattern.test(clean)) return row.label;
  }
  return null;
}

function analyzeVoicemail(text) {
  const match = includesPhrase(text, VOICEMAIL_MATCHES) || includesPattern(text, VOICEMAIL_PATTERNS);
  return {
    isVoicemail: Boolean(match),
    match,
    action: match ? "reject_call" : "continue",
  };
}

// Machine-only phrases that reject at ANY point in the call (the broad gate
// above only runs before the first coachable turn). See VOICEMAIL_ANYTIME_MATCHES.
function analyzeVoicemailAnytime(text) {
  const match = includesPhrase(text, VOICEMAIL_ANYTIME_MATCHES);
  return {
    isVoicemail: Boolean(match),
    match,
    action: match ? "reject_call" : "continue",
  };
}

function analyzeCallScreener(text) {
  const match = includesPhrase(text, CALL_SCREENER_MATCHES);
  return {
    isScreener: Boolean(match),
    match,
    action: match ? "hold_context" : "continue",
  };
}

function analyzeSystemContextClear(text) {
  const match = includesPhrase(text, SYSTEM_CONTEXT_CLEAR_MATCHES);
  return {
    shouldClear: Boolean(match),
    match,
    action: match ? "clear_context" : "continue",
  };
}

function keywordHit(lowerText, keyword) {
  const needle = String(keyword || "").trim().toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9-]+$/i.test(needle)) {
    return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lowerText);
  }
  return lowerText.includes(needle);
}

function isWeakContextHit(keyword) {
  return contextMatchBank.isWeakContextHit(keyword) ||
    WEAK_CONTEXT_HITS.has(String(keyword || "").trim().toLowerCase());
}

function filterContextHits(rule, hits = []) {
  const cleanHits = [...new Set(hits.map((hit) => cleanText(hit, 120)).filter(Boolean))];
  if (!cleanHits.length) return [];
  return cleanHits;
}

function findContextMatches(text, options = {}) {
  return contextMatchBank.findContextCandidateMatches(text, CONTEXT_RULES, options);
}

function normalizeContextCandidate(candidate = {}) {
  const key = cleanText(candidate.key || "", 80);
  if (!key) return null;
  return {
    key,
    label: cleanText(candidate.label || key, 120),
    family: cleanText(candidate.family || "sales", 80),
    priority: Number(candidate.priority || candidate.score || 0) || 0,
    score: Number(candidate.score || candidate.priority || 0) || 0,
    hits: Array.isArray(candidate.hits)
      ? candidate.hits.map((hit) => cleanText(hit, 120)).filter(Boolean)
      : [],
    guidance: cleanText(candidate.guidance || candidate.summary || "", 300),
  };
}

function normalizeContextCandidates(candidates = [], options = {}) {
  return contextMatchBank.normalizeContextCandidates(candidates, options);
}

function candidateToContextMatch(candidate = {}) {
  return {
    key: candidate.key,
    label: candidate.label,
    family: candidate.family,
    priority: Number(candidate.priority || 0),
    hits: Array.isArray(candidate.hits) ? candidate.hits : [],
    guidance: cleanText(candidate.guidance || candidate.summary || "", 300),
    miniConfidence: Number.isFinite(Number(candidate.miniConfidence)) ? Number(candidate.miniConfidence) : undefined,
    miniReason: cleanText(candidate.miniReason || "", 240) || undefined,
    miniSnippet: cleanText(candidate.transcriptFragment || candidate.fragment || "", 180) || undefined,
  };
}

function phraseHas(text, pattern) {
  return pattern.test(cleanText(text, 2400));
}

function hasAnyStrongHit(candidate = {}) {
  return (candidate.hits || []).some((hit) => !isWeakContextHit(hit));
}

function judgeContextCandidate(candidate = {}, phraseText = "", allCandidates = []) {
  const text = cleanText(phraseText, 2400);
  const lower = text.toLowerCase();
  const key = candidate.key;
  const hits = Array.isArray(candidate.hits) ? candidate.hits : [];
  const hasStrongHit = hasAnyStrongHit(candidate);
  let applies = hasStrongHit;
  let confidence = hasStrongHit ? 0.72 : 0.32;
  let reason = hasStrongHit ? "literal strong keyword evidence" : "weak keyword evidence only";

  if (key === "irs_notice") {
    applies = phraseHas(text, /\b(IRS|CP\d{3,4}|LT11|Letter 1058|internal revenue|department of treasury|federal tax|tax bill|balance due|amount due|certified mail|notice of intent|tax year)\b/i);
    confidence = applies ? 0.9 : 0.2;
    reason = applies ? "specific federal/IRS notice signal" : "generic notice or letter without federal context";
  } else if (key === "state_tax") {
    applies = phraseHas(text, /\b(FTB|EDD|franchise tax|department of revenue|department of taxation|state tax|state lien|state levy|state garnishment|state notice|state balance|california tax|california state)\b/i);
    confidence = applies ? 0.88 : 0.2;
    reason = applies ? "specific state tax signal" : "generic state word without tax-agency context";
  } else if (key === "collection_pressure") {
    applies = phraseHas(text, /\b(levy|lien|garnish|garnishment|freeze|frozen|revenue officer|collections|take (my )?(wages|paycheck|check|money)|took money|bank levy|wage levy|seize|seizure|filed (a )?lien|collection notice|levy notice|threaten|threatening)\b/i);
    confidence = applies ? 0.9 : 0.18;
    reason = applies ? "actual enforcement/collection language" : "money word without enforcement pressure";
  } else if (key === "spouse_identity") {
    applies = phraseHas(text, /\b(ex[- ]?(spouse|wife|husband)|divorce|joint|innocent spouse|injured spouse|identity theft|filed jointly|married filing joint|refund taken|offset|not my income|not my debt)\b/i);
    confidence = applies ? 0.82 : 0.22;
    reason = applies ? "spouse/identity affects tax liability or filing status" : "spouse mentioned without tax-liability context";
  } else if (key === "objection") {
    applies = phraseHas(text, /\b(not interested|busy|call me back|already handled|taken care of|accountant|CPA|lawyer|attorney|think about it|ask (my )?(wife|husband|spouse)|talk (to|with) (my )?(wife|husband|spouse)|check (with )?(my )?(wife|husband|spouse)|send me|email me|mail me|not right now|bad time|later|take me off|stop calling|do not call|don't call|remove me)\b/i);
    confidence = applies ? 0.84 : 0.22;
    reason = applies ? "real resistance, callback, third-party, or DNC signal" : "weak sales word without objection context";
  } else if (key === "fees_close") {
    applies = phraseHas(text, /\b(cost|costs|fee|fees|price|pricing|how much|what (this|it) costs|what do you charge|charge|pay today|start today|enroll|retainer|down payment|deposit|afford|expensive|too much)\b/i);
    confidence = applies ? 0.78 : 0.2;
    reason = applies ? "pricing, affordability, or enrollment language" : "generic payment/card/today word without fees context";
  } else if (key === "legitimacy") {
    applies = phraseHas(text, /\b(who are you|who is this|why are you calling|how did you get|where did you get|scam|legit|legitimate|is this real|are you real|spam call|what company|tax advocate|tax group|public record|tax lien record)\b/i);
    confidence = applies ? 0.82 : 0.18;
    reason = applies ? "caller is questioning identity or legitimacy" : "generic company word without legitimacy challenge";
  } else if (key === "representation") {
    applies = phraseHas(text, /\b(represent|representation|power of attorney|POA|2848|8821|authorization|speak (to|for)|call the IRS|deal with (the IRS|them)|take over|on my behalf|representative|pull transcripts|transcript pull)\b/i);
    confidence = applies ? 0.8 : 0.2;
    reason = applies ? "representation or authorization language" : "generic handle/talk/contact word without representation context";
  }

  if (!applies && hasStrongHit && candidate.family === "tax_comprehension") {
    applies = true;
    confidence = Math.max(confidence, 0.68);
    reason = "literal tax-comprehension keyword remains relevant";
  }
  if (!applies && hasStrongHit && candidate.family === "human_context") {
    applies = true;
    confidence = Math.max(confidence, 0.66);
    reason = "literal human-context keyword remains relevant";
  }

  const competingTaxKeys = allCandidates
    .filter((row) => row.key !== key && row.family === "tax_comprehension")
    .map((row) => row.key);
  return {
    ...candidate,
    applies,
    miniConfidence: Number(confidence.toFixed(2)),
    miniReason: reason,
    hitStrength: hasStrongHit ? "strong" : "weak",
    competingTaxKeys,
    hits,
    transcriptFragment: text,
  };
}

function judgeContextCandidates({ phraseText, candidates = [], maxMatches = 6 } = {}) {
  const normalized = normalizeContextCandidates(candidates, { limit: Math.max(maxMatches * 3, 18) });
  const judged = normalized
    .map((candidate) => judgeContextCandidate(candidate, phraseText, normalized))
    .sort((a, b) => {
      const appliesDelta = Number(b.applies) - Number(a.applies);
      if (appliesDelta) return appliesDelta;
      return b.miniConfidence - a.miniConfidence ||
        b.score - a.score ||
        b.priority - a.priority ||
        b.hits.length - a.hits.length ||
        a.key.localeCompare(b.key);
    });
  const selected = judged
    .filter((candidate) => candidate.applies)
    .slice(0, maxMatches)
    .map(candidateToContextMatch);
  const rejected = judged
    .filter((candidate) => !candidate.applies)
    .map((candidate) => ({
      key: candidate.key,
      label: candidate.label,
      hits: candidate.hits,
      reason: candidate.miniReason,
      confidence: candidate.miniConfidence,
    }));
  return {
    selected,
    rejected,
    judged,
    rawCandidateCount: normalized.length,
  };
}

function buildMiniMeaningSummary({ phraseText, matches = [] } = {}) {
  const labels = matches.slice(0, 4).map((match) => match.label).filter(Boolean);
  const clean = cleanText(phraseText, 240);
  if (!labels.length) {
    return `Prospect said: ${clean}. No candidate clearly applies; hold unless this is a direct question.`;
  }
  return `Prospect said: ${clean}. Applicable context: ${labels.join(", ")}.`;
}

function buildLocalMemoryBrief({ phraseText, matches = [], tactics = [], actionReason = "" } = {}) {
  const clean = cleanText(phraseText, 260);
  if (!clean) return null;
  const activeIssues = (Array.isArray(matches) ? matches : [])
    .slice(0, 5)
    .map((match) => ({
      key: cleanText(match.key || "general", 120),
      snippet: cleanText(match.miniSnippet || match.fragment || clean, 180),
      status: "new",
    }))
    .filter((issue) => issue.key || issue.snippet);
  const tacticLabels = (Array.isArray(tactics) ? tactics : [])
    .slice(0, 3)
    .map((tactic) => cleanText(tactic.label || tactic.key || "", 80))
    .filter(Boolean);
  const topKeys = activeIssues.map((issue) => issue.key).filter(Boolean).slice(0, 4);
  return {
    whatHappened: topKeys.length
      ? `Prospect raised ${topKeys.join(", ")}: ${clean}`
      : `Prospect said: ${clean}`,
    activeIssues: activeIssues.length
      ? activeIssues
      : [{ key: "general", snippet: clean, status: "new" }],
    continueFrom: [
      "Respond to the current prospect sentence, not an older line.",
      tacticLabels.length ? `Use this posture: ${tacticLabels.join(", ")}.` : "",
      cleanText(actionReason, 80) ? `Local trigger: ${cleanText(actionReason, 80)}.` : "",
    ].filter(Boolean).join(" "),
  };
}

function formatMemoryBriefForPrompt(memoryBrief = null) {
  if (!memoryBrief || typeof memoryBrief !== "object") return "";
  const rows = [];
  const whatHappened = cleanText(memoryBrief.whatHappened || "", 300);
  if (whatHappened) rows.push(`- Compact read: ${whatHappened}`);
  const activeIssues = Array.isArray(memoryBrief.activeIssues) ? memoryBrief.activeIssues : [];
  if (activeIssues.length) {
    rows.push(`- Active issues: ${activeIssues.slice(0, 6).map((issue) => {
      const key = cleanText(issue?.key || "general", 120);
      const snippet = cleanText(issue?.snippet || "", 180);
      const status = cleanText(issue?.status || "", 60);
      return [key, snippet ? `(${snippet})` : "", status ? `[${status}]` : ""].filter(Boolean).join(" ");
    }).join("; ")}`);
  }
  const continueFrom = cleanText(memoryBrief.continueFrom || "", 280);
  if (continueFrom) rows.push(`- Continue from: ${continueFrom}`);
  return rows.join("\n");
}

function isFiller(text) {
  const clean = cleanText(text, 400);
  if (!clean) return true;
  return FILLER_PATTERNS.some((pattern) => pattern.test(clean));
}

function hasQuestionShape(text) {
  const clean = cleanText(text, 800);
  if (/[?]$/.test(clean)) return true;
  return /^(who|what|why|when|where|how|can|could|should|do|does|did|is|are|am|will|would)\b/i.test(clean);
}

function hasCompleteThoughtTrigger(text) {
  const lower = cleanText(text, 2000).toLowerCase();
  return COMPLETE_THOUGHT_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()));
}

function classifyThoughtCompleteness(text) {
  const clean = cleanText(text, 2000);
  const words = clean ? clean.split(/\s+/).filter(Boolean) : [];
  if (!clean || isFiller(clean)) {
    return { complete: false, reason: "filler_or_empty", wordCount: words.length };
  }
  if (/\.\.\.$/.test(clean) || /\b(and|or|but|because|from|with|about|for|to)$/i.test(clean)) {
    return { complete: false, reason: "trailing_fragment", wordCount: words.length };
  }
  if (/[.!?]$/.test(clean)) {
    return { complete: true, reason: "terminal_punctuation", wordCount: words.length };
  }
  if (hasQuestionShape(clean) && words.length >= 4) {
    return { complete: true, reason: "question_shape", wordCount: words.length };
  }
  if (words.length >= 7 && hasCompleteThoughtTrigger(clean)) {
    return { complete: true, reason: "semantic_trigger", wordCount: words.length };
  }
  return { complete: false, reason: "needs_more_context", wordCount: words.length };
}

function shouldComposeFromContext({ text, contextMatches, completeness, channel }) {
  const clean = cleanText(text, 1200);
  const wordCount = Number(completeness?.wordCount || 0);
  if (!clean || isFiller(clean)) {
    return { shouldCompose: false, reason: "filler_or_empty" };
  }
  // Dual-VAD: the fast channel is ADDITIVE ONLY — its quick finals run the
  // gates and the term bank and accumulate context/memory, but the compose
  // trigger belongs to the semantic turn channel (a completed thought).
  if (channel === "fast") {
    return { shouldCompose: false, reason: "fast_channel_additive" };
  }
  // Completeness is no longer a local/mini gate. A released segment can still be
  // mid-thought. Forward any real (non-filler) prospect utterance and let the
  // coach (Claude) decide thought-completeness and whether to speak or WAIT.
  // completeness stays on the frame as a non-binding hint only.
  if (contextMatches.length) {
    return { shouldCompose: true, reason: "matched_context" };
  }
  if (hasQuestionShape(text) && wordCount >= 3) {
    return { shouldCompose: true, reason: "question_without_keyword_match" };
  }
  return { shouldCompose: true, reason: "vad_release_forward_to_coach" };
}

function buildMiniContextFrame({ phraseText, transcript, metadata = {}, pendingCount = 0, candidateMatches = [] }) {
  const text = normalizeTaxTerms(phraseText);
  const completeness = classifyThoughtCompleteness(text);
  const deterministicMatches = normalizeContextCandidates(candidateMatches, { limit: 18 });
  const rawCandidates = deterministicMatches.length
    ? deterministicMatches
    : normalizeContextCandidates(findContextMatches(text, { limit: 18 }), { limit: 18 });
  const miniJudgement = judgeContextCandidates({
    phraseText: text,
    candidates: rawCandidates,
    maxMatches: 6,
  });
  const contextMatches = miniJudgement.selected;
  const compose = shouldComposeFromContext({ text, contextMatches, completeness, channel: transcript?.channel || null });
  const primary = contextMatches[0] || null;
  const jurisdiction = classifyJurisdiction(text, contextMatches);
  const tactics = deriveConversationTactics({
    phraseText: text,
    matches: contextMatches,
    jurisdiction,
    maxTactics: 4,
  });
  const memoryBrief = buildLocalMemoryBrief({
    phraseText: text,
    matches: contextMatches,
    tactics,
    actionReason: compose.reason,
  });
  return {
    id: null,
    at: new Date().toISOString(),
    type: "mini_context_frame",
    role: transcript.role,
    sourceTranscriptId: transcript.id || null,
    phraseText: text,
    pendingCount,
    completeThought: completeness.complete,
    completenessReason: completeness.reason,
    actionable: compose.shouldCompose,
    actionReason: compose.reason,
    shouldCompose: compose.shouldCompose,
    jurisdiction,
    primaryContextKey: primary?.key || null,
    matches: contextMatches,
    tactics,
    deterministicCandidates: rawCandidates,
    deterministicCandidateCount: rawCandidates.length,
    miniJudgement: {
      modelRole: "local_context_heuristic",
      selectedKeys: contextMatches.map((match) => match.key),
      selectedTactics: tactics.map((tactic) => tactic.key),
      rejected: miniJudgement.rejected,
      candidateCount: miniJudgement.rawCandidateCount,
      transcriptMeaning: buildMiniMeaningSummary({ phraseText: text, matches: contextMatches }),
      memoryBrief,
    },
    memoryBrief,
    metadata: {
      agentName: cleanText(metadata.agentName || "", 120),
      firmName: cleanText(metadata.firmName || "Wynn Tax Solutions", 120),
      uii: cleanText(metadata.uii || "", 120),
      agentEmail: cleanText(metadata.agentEmail || "", 160),
    },
    instructionsForPrompt: buildFixedComposerInstructions({ role: transcript.role }),
  };
}

function classifyJurisdiction(text, matches = findContextMatches(text)) {
  const keys = new Set(matches.map((match) => match.key));
  const clean = cleanText(text, 2000);
  const hasState = keys.has("state_tax");
  const hasFederal =
    keys.has("irs_notice") ||
    keys.has("payroll_tax") ||
    keys.has("self_employment") ||
    keys.has("unfiled_returns") ||
    /\b(IRS|CP\d{3,4}|LT11|Letter 1058|1040|941|940|W-2|1099)\b/i.test(clean);
  if (hasState && hasFederal) return "mixed";
  if (hasState) return "state";
  if (hasFederal || hasCompleteThoughtTrigger(clean)) return "irs";
  return "ambiguous";
}

function deriveConversationTactics({ phraseText = "", matches = [], jurisdiction = "ambiguous", maxTactics = 4 } = {}) {
  const text = cleanText(phraseText, 2400);
  const keys = new Set((Array.isArray(matches) ? matches : []).map((match) => cleanText(match.key, 120)).filter(Boolean));
  const matched = TACTIC_RULES
    .map((rule) => {
      // Fail-soft: a bad applies() in one tactic must never take down the whole frame.
      let applies = false;
      try {
        applies = Boolean(rule.applies({ text, keys, matches, jurisdiction }));
      } catch {
        applies = false;
      }
      if (!applies) return null;
      const contributingKeys = [...keys].filter((key) => {
        if (rule.key === "calm_urgency") return key === "collection_pressure";
        if (rule.key === "human_reassurance") return ["emotional_pressure", "money_pressure"].includes(key);
        if (rule.key === "permission_legitimacy") return key === "legitimacy";
        if (rule.key === "lower_pressure_objection") return key === "objection";
        if (rule.key === "confident_value_frame") return key === "fees_close";
        if (rule.key === "expert_specificity") return ["payroll_tax", "self_employment", "audit_adjustment", "spouse_identity"].includes(key);
        if (rule.key === "shame_reduction") return ["unfiled_returns", "spouse_identity"].includes(key);
        if (rule.key === "state_to_irs_screen") return key === "state_tax";
        // Text-triggered tactics fire on the raw phrasing, not on a detected context
        // key — so they have no contributing context keys (keeps derivedFrom honest and
        // confidence from being inflated by unrelated tax keys that happen to co-occur).
        if ([
          "anchor_to_inquiry",
          "hostility_resilience",
          "loop_in_decision_maker",
          "dissolve_stall",
          "already_represented",
          "earn_trust_with_proof",
          "channel_relief",
        ].includes(rule.key)) return false;
        return true;
      });
      return {
        key: rule.key,
        label: rule.label,
        family: rule.family,
        priority: rule.priority,
        confidence: Number(Math.min(0.95, 0.6 + (contributingKeys.length * 0.08)).toFixed(2)),
        derivedFrom: contributingKeys.slice(0, 6),
        guidance: rule.guidance,
        humor: rule.humor,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Number(maxTactics) || 4));

  if (matched.length) return matched;
  return [{
    key: "clarify_without_overfitting",
    label: "Clarify without overfitting",
    family: "sales_psychology",
    priority: 20,
    confidence: 0.55,
    derivedFrom: [],
    guidance:
      "When the meaning is not clear, ask one plain clarifying question. Do not force a tax program, joke, or pitch angle that the prospect has not earned yet.",
    humor:
      "No humor until the prospect's issue and emotional state are clear.",
  }];
}

const FIXED_AGENT_COMPOSER_INSTRUCTIONS = Object.freeze([
  "This is agent-side feedback. Do not write a prospect-facing answer unless the agent has asked for wording.",
  "Give one concise adjustment that keeps the agent human, calm, and moving toward the next phase.",
]);

const FIXED_PROSPECT_COMPOSER_INSTRUCTIONS = Object.freeze([
  "FIRST, judge turn-completeness. Read the prospect's CURRENT text together with the recent call memory below. If the prospect is still mid-thought, trailing off mid-sentence, or this is a fragment, backchannel ('uh huh', 'okay', 'right'), or filler, reply with EXACTLY: WAIT - one word, nothing else.",
  "Before writing, glance at the last agent and prospect turns in the memory: note silently what the prospect feels and wants right now (fear, skepticism, relief-seeking, pride) and let that read shape the line. Never output the analysis.",
  "Only when the prospect has finished a thought worth answering do you compose a line. When you do:",
  "Output only the exact words the agent should say next - spoken, not written; no labels or meta.",
  "One or two short sentences, usually under 35 words. Anchor on what the prospect just said, then do ONE thing: ask a concrete discovery question, or move toward fact review / representation.",
  "You are an expert tax-resolution consultant meeting the prospect at their level. Carry quiet authority because they reached out without knowing the way out and you do.",
  "No sycophancy or flattery ('great question', 'you're so right'). No asking permission to help ('would it be okay if'). You're already engaged because they submitted the inquiry; proceed with calm assumption.",
  "Do not apologize for calling and do not flinch at a hostile tone; a sharp tone is usually fear or embarrassment, not a verdict. Make one clear attempt to deliver value, then honor a genuine opt-out.",
  "Diagnose before prescribing: never name a program before you know notice type, year, balance, income type, and ability to pay. One question at a time.",
  "Reflect their situation back precisely (not parroting) so they feel understood, then advance. Let real stakes (levy, lien, penalties) speak without manufacturing fear or pressure.",
  "Sound human before salesy whenever there's stress, money, family pressure, shame, fear, or confusion. Use tax comprehension to sound credible, then translate the term into plain consequence.",
  "Humor: light, dry, self-aware, and rare - only to disarm tension, never sarcasm, never at the prospect's expense or about their debt/fear. Drop it entirely if they're distressed or angry.",
  "Apply the conversation-tactic guidance below for the specific psychology, warmth, and humor boundary that fits this exact moment.",
  "If recent call memory is supplied, use it only for continuity, avoiding repeated questions, and knowing what has already been covered. The current prospect text always outranks memory.",
  "Agent-side VAD, when present in recent memory, is optional context only. Never wait for an agent final to decide whether to coach; the current prospect text can release a line by itself.",
  "Use transcript snippets attached to selected context. Do not write from key labels alone, and do not invent facts that are not in the current text or memory snippets.",
  "No DIY tax advice, no program promises before qualification (OIC/CNC/IA/abatement), no guarantees, no savings claims, no timelines, no holds, no legal conclusions.",
  "Default tax-ish issues to IRS unless a clear state agency is named; if state appears, also screen for an IRS/federal issue.",
  "Use only the supplied firm and agent names. Do not invent people, firms, facts, balances, or deadlines - when unsure, ask.",
]);

const SONNET_PROSPECT_SYSTEM_PROMPT = [
  "You are a live tax-resolution sales dialog composer for phone calls.",
  "You receive normalized prospect text plus the tax/sales context and conversation tactics selected for THIS moment.",
  "Your job is not transcription and not legal advice - first decide whether the prospect completed a coachable thought (reply WAIT if not), otherwise produce one line the agent can say right now.",
  "Ground every line in the RAW prospect text in the user message. Apply only the tactics listed for this turn; ignore any standing directive that doesn't fit what was actually said. Never restate instructions back.",
  "",
  "Standing directives:",
  ...FIXED_PROSPECT_COMPOSER_INSTRUCTIONS.map((line) => `- ${line}`),
].join("\n");

// OPENING-PHASE system prompt (the prospect's first few turns): there is no
// accumulated context yet and none is needed — the job is the call opening,
// run close to verbatim. Separate STABLE prompt so it gets its own Anthropic
// cache prefix (never mix per-call data in here).
const SONNET_OPENING_SYSTEM_PROMPT = [
  "You are a live tax-resolution sales dialog composer for the OPENING moments of an outbound phone call.",
  "The prospect submitted a tax-debt inquiry; the agent is calling them back. These are the first exchanges — there is no call memory yet and you do not need any.",
  "Reply WAIT only for pure noise (a cough, a half-ring, dead air). Otherwise ALWAYS give the agent their next opening line, fast.",
  "",
  "Standing directives:",
  "- Output only the exact words the agent should say next - spoken, not written; no labels or meta. One short sentence or two, under 25 words.",
  "- Run the opening sequence in order, advancing one step per turn: (1) confirm you're speaking with the prospect by first name; (2) self-identify - agent first name + firm name - and anchor to THEIR inquiry about their tax situation; (3) first discovery question: what notice or letter did they get, or what's going on with the IRS or state.",
  "- Stay close to these shapes, personalized with the supplied names: 'Hi, is this {prospect}?' -> '{Prospect}, it's {agent} with {firm} - you reached out about your tax situation, so I'm following up on that.' -> 'So I can point you the right way: did you get a notice or letter recently, or is this about back balances or unfiled years?'",
  "- If they answer a step, take the next one. If they object early ('who is this', 'not interested', 'busy'), answer it in one calm sentence anchored to their inquiry, then return to the sequence. Never apologize for calling.",
  "- Use only the supplied agent, firm, and prospect names. No program talk, no promises, no DIY advice this early - the opening earns the conversation, nothing more.",
].join("\n");

const SONNET_AGENT_SYSTEM_PROMPT = [
  "You are a live tax-resolution sales dialog composer for phone calls.",
  "This turn is agent-side feedback, not a prospect response.",
  "",
  "Standing directives:",
  ...FIXED_AGENT_COMPOSER_INSTRUCTIONS.map((line) => `- ${line}`),
].join("\n");

function buildFixedComposerInstructions({ role = "prospect" } = {}) {
  return role === "prospect"
    ? [...FIXED_PROSPECT_COMPOSER_INSTRUCTIONS]
    : [...FIXED_AGENT_COMPOSER_INSTRUCTIONS];
}

function buildCacheableComposerSystem({ role = "prospect", callPhase = "" } = {}) {
  if (role !== "prospect") return SONNET_AGENT_SYSTEM_PROMPT;
  // Both prompts are STABLE constants — each gets its own cache prefix.
  return callPhase === "opening" ? SONNET_OPENING_SYSTEM_PROMPT : SONNET_PROSPECT_SYSTEM_PROMPT;
}

function buildLegacyFixedComposerInstructions({ role = "prospect" } = {}) {
  if (role !== "prospect") {
    return [
      "This is agent-side feedback. Do not write a prospect-facing answer unless the agent has asked for wording.",
      "Give one concise adjustment that keeps the agent human, calm, and moving toward the next phase.",
    ];
  }
  return [
    // Completeness gate: the coach is now the turn decider. VAD only cuts on silence, so
    // the prospect text may be a partial thought.
    "FIRST, judge turn-completeness. Read the prospect's CURRENT text together with the recent call memory below. If the prospect is still mid-thought, trailing off mid-sentence, or this is a fragment, backchannel ('uh huh', 'okay', 'right'), or filler, reply with EXACTLY: WAIT — one word, nothing else.",
    "Before writing, glance at the last agent and prospect turns in the memory: note silently what the prospect feels and wants right now (fear, skepticism, relief-seeking, pride) and let that read shape the line. Never output the analysis.",
    "Only when the prospect has finished a thought worth answering do you compose a line. When you do:",
    // Output shape
    "Output only the exact words the agent should say next — spoken, not written; no labels or meta.",
    "One or two short sentences, usually under 35 words. Anchor on what the prospect just said, then do ONE thing: ask a concrete discovery question, or move toward fact review / representation.",
    // Persona & status
    "You are an expert tax-resolution consultant meeting the prospect at their level. Carry quiet authority — they reached out because they don't know the way out and you do.",
    "No sycophancy or flattery ('great question', 'you're so right'). No asking permission to help ('would it be okay if'). You're already engaged because they submitted the inquiry — proceed with calm assumption.",
    "Do not apologize for calling and do not flinch at a hostile tone; a sharp tone is usually fear or embarrassment, not a verdict. Make one clear attempt to deliver value, then honor a genuine opt-out.",
    // Psychology
    "Diagnose before prescribing: never name a program before you know notice type, year, balance, income type, and ability to pay. One question at a time.",
    "Reflect their situation back precisely (not parroting) so they feel understood, then advance. Let real stakes (levy, lien, penalties) speak without manufacturing fear or pressure.",
    "Sound human before salesy whenever there's stress, money, family pressure, shame, fear, or confusion. Use tax comprehension to sound credible, then translate the term into plain consequence.",
    // Humor
    "Humor: light, dry, self-aware, and rare — only to disarm tension, never sarcasm, never at the prospect's expense or about their debt/fear. Drop it entirely if they're distressed or angry.",
    // Defer to situational tactics
    "Apply the conversation-tactic guidance below for the specific psychology, warmth, and humor boundary that fits this exact moment.",
    "If recent call memory is supplied, use it only for continuity, avoiding repeated questions, and knowing what has already been covered. The current prospect text always outranks memory.",
    "Use transcript snippets attached to selected context. Do not write from key labels alone, and do not invent facts that are not in the current text or memory snippets.",
    // Compliance guardrails
    "No DIY tax advice, no program promises before qualification (OIC/CNC/IA/abatement), no guarantees, no savings claims, no timelines, no holds, no legal conclusions.",
    "Default tax-ish issues to IRS unless a clear state agency is named; if state appears, also screen for an IRS/federal issue.",
    "Use only the supplied firm and agent names. Do not invent people, firms, facts, balances, or deadlines — when unsure, ask.",
  ];
}

function buildSonnetPromptPayload({ contextFrame, metadata = {} }) {
  const agentName = cleanText(metadata.agentName || contextFrame?.metadata?.agentName || "the agent", 120);
  const firmName = cleanText(metadata.firmName || contextFrame?.metadata?.firmName || "Wynn Tax Solutions", 120);
  const matches = Array.isArray(contextFrame?.matches) ? contextFrame.matches : [];
  const tactics = Array.isArray(contextFrame?.tactics) ? contextFrame.tactics : [];
  const memoryBriefText = formatMemoryBriefForPrompt(contextFrame?.memoryBrief || contextFrame?.miniJudgement?.memoryBrief || null);
  // SYSTEM = the STABLE prefix: role + standing directives. Identical on every call,
  // so the composer marks it cache_control:ephemeral (Anthropic prompt caching). The
  // big instruction block lives here ONCE instead of bleeding through every user turn.
  // Keep zero per-call data in here or the cache prefix won't match.
  let system = [
    "You are a live tax-resolution sales dialog composer for phone calls.",
    "You receive normalized prospect text plus the tax/sales context and conversation tactics selected for THIS moment.",
    "Your job is not transcription and not legal advice — first decide whether the prospect completed a coachable thought (reply WAIT if not), otherwise produce one line the agent can say right now.",
    "Ground every line in the RAW prospect text in the user message. Apply only the tactics listed for this turn; ignore any standing directive that doesn't fit what was actually said. Never restate instructions back.",
    "",
    "Standing directives:",
    // The frame precomputes instructionsForPrompt (the same static set); use it so
    // there's one source of truth, and keep it in this cached prefix only.
    ...((Array.isArray(contextFrame?.instructionsForPrompt) && contextFrame.instructionsForPrompt.length
      ? contextFrame.instructionsForPrompt
      : buildFixedComposerInstructions()).map((line) => `- ${line}`)),
  ].join("\n");
  system = buildCacheableComposerSystem({
    role: contextFrame?.role || "prospect",
    callPhase: contextFrame?.callPhase || "",
  });

  // USER = the DYNAMIC per-turn delta only: names, jurisdiction, raw transcript, the
  // context + tactics chosen for this moment. No standing instructions here.
  const contactName = cleanText(metadata.contactName || contextFrame?.metadata?.contactName || "", 120);
  const user = [
    `Agent name: ${agentName}`,
    `Firm name: ${firmName}`,
    contactName ? `Prospect name: ${contactName}` : "",
    contextFrame?.callPhase === "opening" ? `Call phase: OPENING (prospect turn ${Number(contextFrame?.prospectTurnCount || 0) || 1})` : "",
    `Jurisdiction bucket: ${contextFrame?.jurisdiction || "ambiguous"}`,
    "",
    "Prospect text:",
    contextFrame?.phraseText || "",
    "",
    memoryBriefText ? "Mini compact memory for this turn:" : "",
    memoryBriefText,
    memoryBriefText ? "" : "",
    "Matched context:",
    matches.length
      ? matches.map((match) => [
        `- ${match.label}: ${match.guidance}`,
        match.miniSnippet ? `  Transcript snippet: ${match.miniSnippet}` : "",
        Array.isArray(match.hits) && match.hits.length ? `  Deterministic hits: ${match.hits.join(", ")}` : "",
        match.miniReason ? `  Mini reason: ${match.miniReason}` : "",
      ].filter(Boolean).join("\n")).join("\n")
      : "- No strong keyword match. Keep it to one clarifying discovery question.",
    "",
    "Conversation tactic:",
    tactics.length
      ? tactics.map((tactic) => [
        `- ${tactic.label}: ${tactic.guidance}`,
        tactic.humor ? `  Humor boundary: ${tactic.humor}` : "",
        tactic.derivedFrom?.length ? `  Derived from: ${tactic.derivedFrom.join(", ")}` : "",
      ].filter(Boolean).join("\n")).join("\n")
      : "- Use direct discovery. No humor unless the prospect is calm and the issue is clear.",
  ];
  return {
    provider: "anthropic",
    modelRole: "sonnet_dialog_composer",
    system,
    systemCacheable: true,
    user: user.join("\n"),
    maxOutputWords: 35,
    shouldCompose: Boolean(contextFrame?.shouldCompose),
  };
}

function createSonnetDialogDraft({ contextFrame, metadata = {} }) {
  const promptPayload = buildSonnetPromptPayload({ contextFrame, metadata });
  if (!contextFrame?.shouldCompose) {
    return {
      status: "wait",
      label: "Waiting for a coach-worthy thought",
      say: "",
      guidance: contextFrame?.actionReason || "No complete/actionable prospect thought yet.",
      promptPayload,
    };
  }

  const matchByKey = (key) => contextFrame.matches.find((match) => match.key === key) || null;
  const primary =
    matchByKey("collection_pressure") ||
    matchByKey("emotional_pressure") ||
    matchByKey("money_pressure") ||
    contextFrame.matches[0] ||
    null;
  const label = primary?.label || "Discovery";
  const phrase = contextFrame.phraseText;
  const jurisdiction = contextFrame.jurisdiction;
  const primaryTactic = Array.isArray(contextFrame.tactics) ? contextFrame.tactics[0] : null;
  let say;

  if (primary?.key === "collection_pressure") {
    say = "That sounds urgent, especially if it may affect your money directly. Is anything being levied or garnished right now, or is this still at the warning stage?";
  } else if (primary?.key === "state_tax" && jurisdiction === "state") {
    say = "State issues can move differently than IRS cases, so I want to separate the two. Is this only with the state, or do you also have any IRS balance or unfiled years?";
  } else if (primary?.key === "unfiled_returns") {
    say = "That can make the balance look worse than it really is. What is the last year you remember filing, and was the income W-2, 1099, or business income?";
  } else if (primary?.key === "payroll_tax") {
    say = "Payroll cases have to be handled carefully because business and personal exposure can split. Are these unpaid 941 quarters, and is the business still operating?";
  } else if (primary?.key === "self_employment") {
    say = "With 1099 income, the key is figuring out the years, income, and whether expenses were counted. What year is this from?";
  } else if (primary?.key === "emotional_pressure" || primary?.key === "money_pressure") {
    say = "I can hear why that feels heavy. Before we guess at a solution, what notice, year, and amount are they showing you?";
  } else if (primary?.key === "legitimacy") {
    say = `This is ${metadata.agentName || "your representative"} with ${metadata.firmName || "Wynn Tax Solutions"}, and I want to make sure I am looking at the right tax issue. Did you recently get a notice or request help online?`;
  } else if (primary?.key === "fees_close") {
    say = "The fee depends on the scope, so I do not want to guess before we know the facts. What years, notices, and balances are we actually dealing with?";
  } else if (primary?.key === "representation") {
    say = "Representation is how we get the facts and communicate properly; it is not a guess at the final answer. What notice or balance are we starting from?";
  } else {
    say = jurisdiction === "ambiguous"
      ? "Good question. Is this coming from the IRS or the state, and what year or notice are you looking at?"
      : "Before we talk solutions, let's get the facts straight. What year, balance, and notice are you looking at?";
  }

  return {
    status: "ready",
    label,
    say,
    guidance: [
      primary?.guidance || "Ask one clarifying discovery question.",
      primaryTactic?.guidance || "",
    ].filter(Boolean).join(" "),
    tactic: primaryTactic || null,
    promptPayload,
    sourceText: phrase,
  };
}

function createSanitizedLiveCoachPipeline({ metadata = {} } = {}) {
  const state = {
    rejected: false,
    transcriptCount: 0,
    coachableCount: 0,
    pendingByRole: {
      prospect: [],
      agent: [],
      system: [],
      unknown: [],
    },
    sentenceBankByRole: {
      prospect: [],
      agent: [],
      system: [],
      unknown: [],
    },
  };

  function handleTranscript(input = {}) {
    if (state.rejected) {
      return {
        action: "ignore_rejected_session",
        transcript: null,
        context: null,
        dialog: null,
        state: snapshot(),
      };
    }

    const transcript = normalizeSttTranscript(input);
    if (!transcript.text) {
      return { action: "ignore_empty", transcript: null, context: null, dialog: null, state: snapshot() };
    }

    state.transcriptCount += 1;
    // Agent-channel rows are the agent's own mic: never run them through the
    // voicemail/screener/system gates (an agent saying "just leave me a message
    // if we get cut off" must not voicemail-reject the session). Store as
    // composer context and exit before any gate.
    if (transcript.role === "agent") {
      state.sentenceBankByRole.agent = state.sentenceBankByRole.agent || [];
      state.sentenceBankByRole.agent.push(transcript.text);
      return {
        action: "store_non_prospect",
        transcript,
        context: null,
        dialog: null,
        state: snapshot(),
      };
    }
    const contextClear = analyzeSystemContextClear(transcript.text);
    const screener = analyzeCallScreener(transcript.text);
    const voicemail = analyzeVoicemail(transcript.text);
    // Unambiguous machine audio (deposit menus, forward announcements, carrier
    // intercepts) rejects at ANY point — a missed greeting or stray early
    // fragment must not disable the gate and let the bridge transcribe the
    // entire voicemail deposit.
    const anytimeVoicemail = analyzeVoicemailAnytime(transcript.text);
    if (anytimeVoicemail.isVoicemail) {
      state.rejected = true;
      const dialog = {
        status: "rejected",
        label: "Call rejected for voicemail match",
        say: "",
        guidance: `Deterministic machine-audio phrase matched mid-call: ${anytimeVoicemail.match}`,
      };
      return {
        action: "reject_voicemail",
        transcript,
        context: null,
        dialog,
        state: snapshot(),
      };
    }
    if (state.coachableCount === 0 && voicemail.isVoicemail && !screener.isScreener) {
      state.rejected = true;
      const dialog = {
        status: "rejected",
        label: "Call rejected for voicemail match",
        say: "",
        guidance: `Deterministic voicemail phrase matched: ${voicemail.match}`,
      };
      return {
        action: "reject_voicemail",
        transcript,
        context: null,
        dialog,
        state: snapshot(),
      };
    }

    // Marked finals (low logprob / primer echo) inform but never coach: they
    // reach the client grayed and the voicemail gates ABOVE still see them
    // (garbled machine greetings were the whole point of delivering them),
    // but they must not run the match bank. The primer vocabulary IS the
    // match vocabulary — an echoed bank self-matches and ships junk lines.
    if (transcript.lowConfidence || transcript.primerEcho) {
      return {
        action: "store_low_confidence",
        transcript,
        context: null,
        dialog: null,
        state: snapshot(),
      };
    }

    if (contextClear.shouldClear) {
      state.pendingByRole.prospect = [];
      state.pendingByRole.agent = [];
      state.pendingByRole.unknown = [];
      state.sentenceBankByRole.system.push(transcript.text);
      return {
        action: "clear_context_system_prompt",
        transcript: { ...transcript, role: "system", nonProspectReason: `system_context_clear:${contextClear.match}` },
        context: null,
        dialog: null,
        hold: {
          reason: "system_context_clear",
          match: contextClear.match,
          pendingText: "",
        },
        state: snapshot(),
      };
    }

    if (screener.isScreener) {
      state.pendingByRole.prospect = [];
      state.pendingByRole.agent = [];
      state.pendingByRole.unknown = [];
      state.sentenceBankByRole.system.push(transcript.text);
      return {
        action: "hold_call_screener",
        transcript: { ...transcript, role: "system", nonProspectReason: `call_screener:${screener.match}` },
        context: null,
        dialog: null,
        hold: {
          reason: "call_screener",
          match: screener.match,
          pendingText: "",
        },
        state: snapshot(),
      };
    }

    if (transcript.role !== "prospect") {
      state.sentenceBankByRole[transcript.role] = state.sentenceBankByRole[transcript.role] || [];
      state.sentenceBankByRole[transcript.role].push(transcript.text);
      return {
        action: "store_non_prospect",
        transcript,
        context: null,
        dialog: null,
        state: snapshot(),
      };
    }

    const pending = state.pendingByRole.prospect;
    const phraseText = normalizeTaxTerms([...pending, transcript.text].join(" "));
    const context = buildMiniContextFrame({
      phraseText,
      transcript,
      metadata,
      pendingCount: pending.length,
      candidateMatches: input.candidateMatches || input.contextCandidates || [],
    });

    if (!context.shouldCompose) {
      // Fast-channel rows are a PARALLEL decode of the same audio the turn
      // channel will deliver as a completed thought — pushing them into
      // pending would make the turn phrase contain the speech twice.
      if (transcript.channel !== "fast") pending.push(transcript.text);
      return {
        action: "hold_for_more_context",
        transcript,
        context,
        dialog: null,
        hold: {
          reason: context.actionReason,
          completeThought: context.completeThought,
          pendingText: phraseText,
        },
        state: snapshot(),
      };
    }

    state.pendingByRole.prospect = [];
    state.sentenceBankByRole.prospect.push(phraseText);
    state.coachableCount += 1;
    const dialog = createSonnetDialogDraft({ contextFrame: context, metadata });
    return {
      action: "compose_dialog",
      transcript,
      context,
      dialog,
      state: snapshot(),
    };
  }

  function snapshot() {
    return {
      rejected: state.rejected,
      transcriptCount: state.transcriptCount,
      coachableCount: state.coachableCount,
      pendingByRole: {
        prospect: state.pendingByRole.prospect.slice(),
        agent: state.pendingByRole.agent.slice(),
        system: state.pendingByRole.system.slice(),
        unknown: state.pendingByRole.unknown.slice(),
      },
      sentenceCounts: Object.fromEntries(
        Object.entries(state.sentenceBankByRole).map(([role, rows]) => [role, rows.length]),
      ),
    };
  }

  function commitPending(role = "prospect", phraseText = "") {
    const normalizedRole = normalizeRole(role);
    state.pendingByRole[normalizedRole] = [];
    const clean = normalizeTaxTerms(phraseText);
    if (clean) {
      state.sentenceBankByRole[normalizedRole] = state.sentenceBankByRole[normalizedRole] || [];
      state.sentenceBankByRole[normalizedRole].push(clean);
    }
    return snapshot();
  }

  return {
    handleTranscript,
    commitPending,
    snapshot,
  };
}

module.exports = {
  CALL_SCREENER_MATCHES,
  SYSTEM_CONTEXT_CLEAR_MATCHES,
  CONTEXT_RULES,
  VOICEMAIL_MATCHES,
  analyzeCallScreener,
  analyzeSystemContextClear,
  VOICEMAIL_ANYTIME_MATCHES,
  analyzeVoicemail,
  analyzeVoicemailAnytime,
  buildFixedComposerInstructions,
  buildMiniContextFrame,
  buildSonnetPromptPayload,
  classifyJurisdiction,
  classifyThoughtCompleteness,
  cleanText,
  createSanitizedLiveCoachPipeline,
  createSonnetDialogDraft,
  deriveConversationTactics,
  findContextMatches,
  normalizeContextCandidates,
  normalizeSttTranscript,
  normalizeTaxTerms,
  shouldComposeFromContext,
};
