"use strict";

// ── Objection playbook ────────────────────────────────────────────────────────
// Structured objection table for the live coach: deterministic phrase patterns
// -> a SPECIFIC overcoming strategy (broader than a single response line).
//
// Each entry matches the context-rule shape (key/label/family/priority/
// keywords/guidance) so it rides the existing deterministic match bank, PLUS a
// `playbook` block the composer renders when the objection fires:
//   read     — what is actually going on in the prospect's head
//   reframe  — the conceptual move that dissolves the objection
//   moves    — 2-4 concrete plays, in order of preference
//   lines    — example lines in the floor's voice (NOT scripts to read verbatim;
//              Claude adapts them to the moment)
//
// Seeded from the trainer-bot objection library + classic sales objections.
// This table is meant to be EDITED — keys are stable, content is living.
//
// DOCTRINE (rides every playbook delivery): the goal of every objection play
// is to ADVANCE — toward sensitive information, toward agreeing to pay, or at
// minimum toward continuing the conversation. The coach NEVER apologizes for
// the call and NEVER suggests backing off; it only offers ways through. The
// AGENT decides when to move on — the coach does not make that call for them.
// (Sole exception: an explicit do-not-call demand is honored — that's law.)
const OBJECTION_DOCTRINE = [
  "Objection doctrine: every play advances the call — toward sensitive info, toward agreeing to pay, or toward continued conversation. Never apologize for calling, never suggest retreating or 'giving them space' — offer the way THROUGH. The agent decides when to quit — you never do. Only an explicit do-not-call demand ends the attempt.",
  "Classic mechanics, all fair game: (1) An objection is a REQUEST FOR MORE INFORMATION; a condition is a genuine inability — test which one you have before playing ('is it that you can't, or that you're not sure it's worth it?'). (2) Objections are buying signals — a prospect who argues is still on the phone; silence is the real enemy. (3) Agree first, always — 'you're right to ask that' disarms; resistance feeds the objection. (4) ISOLATE before answering: 'if we solved that, is there anything else?' — or you'll answer five objections that were really one. (5) FEEL-FELT-FOUND for emotional objections: I understand how you feel / others felt the same / here's what they found. (6) BOOMERANG: the objection itself is the reason to act ('it's BECAUSE money is tight that the garnishment matters'). (7) PORCUPINE: answer a question with a better question to keep control. (8) REDUCTION: break big numbers into per-day/per-month terms against the cost of inaction. (9) TAKEAWAY (negative reverse): briefly agreeing they might not need help makes a defensive prospect argue your side. (10) Always close on an ALTERNATIVE CHOICE ('tonight at 6 or tomorrow at 10?'), never a yes/no.",
  "Reads that change the play: (11) Price, timeline, and how-does-it-work questions are BUYING SIGNALS dressed as objections — a prospect asking 'how much' is picturing themselves as a client; answer the momentum, not just the words. (12) After a stakes statement or a number lands, STOP TALKING — that silence belongs to the prospect, and whoever fills it first gives something up. (13) Watch commitment language: 'would' turning into 'will', 'if' turning into 'when' — when their tense shifts forward, stop selling and start scheduling; talking past the close is how sold deals die.",
].join("\n");

const OBJECTION_PLAYBOOK = Object.freeze([
  // ── COMPLIANCE: DNC / revocation — NOT an objection ────────────────────────
  // "Stop calling" is a legal revocation, not a sales objection. It routes to
  // a TERMINAL compliance directive: when this matches, the prompt carries
  // ONLY the directive (no doctrine, no overcome plays — see
  // formatObjectionPlaybookForPrompt). "Not interested" stays coachable below.
  {
    key: "dnc_revocation",
    label: "DNC / revocation — terminal, honor immediately",
    family: "compliance_dnc",
    priority: 99,
    keywords: [
      "stop calling", "don't call me", "dont call me", "do not call", "take me off",
      "off your list", "remove my number", "quit calling", "never call", "stop contacting me",
      "do not contact me",
    ],
    playbook: {
      read: "This is a do-not-call demand — a legal revocation under TCPA, not a negotiating position.",
      reframe: "There is no reframe. Compliance IS the move, and doing it gracefully is the only brand-protecting play left.",
      moves: [
        "Confirm the removal explicitly and immediately — no value statement, no one-more-question, no pause.",
        "End warmly and briefly; a clean exit is the last impression.",
      ],
      lines: [
        "Understood — I'm removing your number right now. You won't hear from us again. Take care.",
      ],
    },
  },
  {
    key: "obj_not_interested",
    label: "Not interested (no removal demand)",
    priority: 96,
    keywords: [
      "not interested", "no thanks", "no thank you", "i'm good", "im good", "we're all set",
      "not for me", "don't need it", "dont need it",
    ],
    playbook: {
      read: "Reflex brush-off, not a verdict — they answered an unknown number mid-task. (If they demand removal — 'stop calling', 'take me off' — that is DNC, not this: honor it, never overcome it.)",
      reframe: "You are not selling — you are returning THEIR inquiry about a problem that does not go away on its own.",
      moves: [
        "Anchor to their inquiry immediately (source + their tax issue) — that's what separates you from every robocall.",
        "One value sentence tied to consequence (notice deadlines, penalties compounding), then ONE question — a question keeps the conversation alive where a pitch ends it.",
        "Re-engage off their own facts: 'not interested in fixing the balance, or not interested in sales calls? Those are different things.'",
      ],
      lines: [
        "Totally fair — quick context: you'd reached out about the tax balance, and the reason I'm calling now is those IRS letters have clocks on them. Did the last one mention a levy?",
        "I hear you. Before I let you go — was the back-tax issue handled, or is it still sitting there?",
      ],
    },
  },
  {
    key: "obj_dont_trust_tax_companies",
    label: "Don't trust tax-resolution companies / sounds like a scam",
    priority: 95,
    keywords: [
      "scam", "is this a scam", "don't trust", "you people are crooks", "tax relief companies are",
      "heard bad things", "companies like yours", "rip people off", "too good to be true",
      "are you legit", "sounds like a scheme", "fraud",
    ],
    playbook: {
      read: "They've heard the radio ads and the horror stories — skepticism here is RATIONAL. Often masks a prior bad experience or fear of being burned while vulnerable.",
      reframe: "Agree with the premise — the industry has earned the skepticism — and separate yourself with verifiable specifics instead of reassurance.",
      moves: [
        "Validate first: 'you're right to be careful' lands better than any defense.",
        "Offer live verification: pull up the website, look up the firm, licensed-practitioner registry — while on the phone.",
        "Shift from promises to process: explain WHAT happens (POA, transcripts, compliance review) — process talk is what scammers can't do.",
        "Never promise outcomes or savings numbers — guarantee-talk confirms their fear.",
      ],
      lines: [
        "Honestly? You should be skeptical — there's been garbage in this industry. Pull up our site right now while we talk; I'll wait.",
        "I'm not going to promise you a settlement number — anyone who does on a first call is lying to you. What I can tell you is exactly what we'd do first.",
      ],
    },
  },
  {
    key: "obj_spouse_consult",
    label: "Need to talk to my wife / husband first",
    priority: 90,
    keywords: [
      "talk to my wife", "talk to my husband", "ask my wife", "ask my husband",
      "my spouse", "talk it over with", "we make decisions together", "check with my partner",
      "talk to my family first",
    ],
    playbook: {
      read: "Sometimes genuine (joint finances, joint return = spouse is legally involved), often a soft exit. The tell: a genuine consult has logistics; a dodge is vague. Either way, the play is the same: make the consult happen NOW, on this call, instead of releasing to a maybe.",
      reframe: "The spouse isn't an obstacle — on a joint return they're a PARTY with their own liability. The consult isn't a reason to end the call; it's the next step OF the call.",
      moves: [
        "Qualify the gate first: 'do you need their sign-off, or do you two just like to talk things through?' — separates a decision-gate from a comfort ritual.",
        "Get them on the line NOW: 'are they home? Grab them — I'd rather explain this once to both of you than have you retell it.' Immediate conference beats any callback.",
        "If truly unavailable: lock a specific three-way time TODAY or tomorrow — day, hour, both parties — and keep collecting case info in the meantime ('so I'm ready for that call, which years are unfiled?').",
        "Joint-return leverage: the spouse's own exposure (joint liability) makes this THEIR conversation too — tonight, not someday.",
      ],
      lines: [
        "Is she home right now? Put her on — this is her balance too on a joint return, and I'd rather both of you hear it once than have you translate it over dinner.",
        "Do you need her okay, or do you two just talk things through? Either way — grab her, this takes ten minutes with both of you on.",
        "If she's at work, let's set the three of us for 6 tonight. And while I have you — so I'm ready for that call — which years are we dealing with?",
      ],
    },
  },
  {
    key: "obj_need_to_think",
    label: "I need to think about it",
    priority: 90,
    keywords: [
      "think about it", "need some time", "sleep on it", "mull it over",
      "let me think", "not ready to decide", "give me a few days", "need to process",
    ],
    playbook: {
      read: "Almost never about thinking — it's an unvoiced concern (price, trust, fear of commitment) they'd rather not say out loud. The job is surfacing WHICH one, gently.",
      reframe: "Thinking is fine; thinking about the RIGHT question is the service you provide. Isolate the real hesitation before releasing the call.",
      moves: [
        "Isolate immediately: 'usually when someone says that it's one of two things — the cost, or whether this will actually work. Which is closer?' Then answer THAT objection and advance.",
        "Conditional close: 'if we sorted that piece out right now, would you be ready to get started today?' — commits them to the real blocker.",
        "Attach a consequence clock: deadlines on notices don't pause for thinking — what exactly would they know tomorrow that they don't know now?",
        "Keep collecting while they 'think': 'while you're weighing it, let me at least tell you what the transcripts would show' — the conversation continuing IS the advance.",
      ],
      lines: [
        "Sure — and usually that means one of two things: the fee, or whether this actually works. Which one are we really talking about?",
        "What would you know tomorrow that you don't know right now? That CP504 deadline doesn't take the night off. Let's figure out the real question while I have you.",
        "If the fee piece made sense, is there anything else stopping you from getting this moving today?",
      ],
    },
  },
  {
    key: "obj_cant_afford",
    label: "Can't afford it right now",
    priority: 92,
    keywords: [
      "can't afford", "cant afford", "no money for this", "broke right now",
      "money is tight", "don't have the money", "afford this right now", "too broke",
    ],
    playbook: {
      read: "Usually TRUE — they owe the IRS precisely because money is tight. Treat it as a real constraint, not a negotiation tactic. Shame often rides along; keep dignity intact.",
      reframe: "The fee competes with what the IRS is ALREADY taking (or about to take) — frame cost against the cost of inaction, never against their groceries.",
      moves: [
        "Test objection vs CONDITION first: 'is it that the money truly isn't there, or that you're not sure this is worth it?' — different answers, different plays.",
        "BOOMERANG: it's BECAUSE money is tight that the garnishment/levy exposure matters — the IRS takes from people who can least afford it.",
        "Normalize: 'most people we help are in exactly that spot — that's why the IRS is the problem.'",
        "Quantify inaction: penalties/interest accrual, levy exposure, garnishment math vs the fee.",
        "Phase the engagement or fee plan — smaller first step (compliance/investigation phase) instead of the full quote.",
        "If it's a true condition (no capacity at all): pivot to hardship/CNC qualification — which itself advances the call into full financial disclosure.",
      ],
      lines: [
        "That's exactly why this matters — the IRS doesn't pause while money's tight, they garnish. The penalties this year alone are likely more than the first phase of the fee.",
        "Let's not start with the whole thing. The first step is getting your transcripts and stopping the bleeding — that piece is a fraction of what you heard.",
      ],
    },
  },
  {
    key: "obj_price_too_high",
    label: "Too expensive / why does it cost so much",
    priority: 88,
    keywords: [
      "too expensive", "that's a lot of money", "seems expensive", "why is it so much",
      "cheaper somewhere else", "that much", "cost so much", "price is high", "lot of money",
    ],
    playbook: {
      read: "Different from can't-afford: they HAVE capacity but doubt the value. They're comparing against TurboTax, a CPA's hourly rate, or the $205 DIY OIC fee they read about.",
      reframe: "Price anchors against the BALANCE and the years of exposure, not against software. Representation is insurance + leverage, not form-filling.",
      moves: [
        "Re-anchor: fee as a percentage of the debt and of the penalties already accrued this year.",
        "REDUCTION: break the fee into per-day terms against the daily cost of inaction ('this runs less per day than the interest the IRS is adding').",
        "BOOMERANG: it's because the number feels big that representation matters — big balances are exactly what the IRS escalates on.",
        "Differentiate the work: transcripts, POA, negotiation posture — what the cheap routes don't include (and what failure there costs).",
        "Itemize what phase one actually does — vague 'we handle it' justifies nothing. Then isolate: 'if the value was clear, is the number itself workable?'",
      ],
      lines: [
        "Against a $40k balance growing at the IRS's rates, the fee is a rounding error — and it's the only number in this whole situation that's fixed.",
        "TurboTax files returns. It doesn't stand between you and a revenue officer. That's the part you're buying.",
      ],
    },
  },
  {
    key: "obj_diy_self_rep",
    label: "I'll handle it myself / talk to the IRS directly",
    priority: 85,
    keywords: [
      "handle it myself", "deal with them myself", "call the irs myself", "talk to the irs myself",
      "do it myself", "turbotax", "turbo tax", "i can file myself", "oic myself",
      "do my own taxes", "figure it out myself",
    ],
    playbook: {
      read: "Pride + cost-saving + a real fact: some simple cases ARE DIY-able. Respect the competence; the angle is asymmetry of information and stakes, not their ability.",
      reframe: "The IRS agent on that call works for the IRS. Everything they say is recorded and usable; representation flips who the system listens to.",
      moves: [
        "TAKEAWAY (negative reverse): concede the simple case honestly — 'if it's one year and under ten grand, you might be right, you may not need anyone.' A defensive prospect will start arguing your side ('well, it's actually four years...').",
        "Asymmetry: they'll be negotiating their first case against someone who's done thousands — and disclosure rules bind THEM, not you.",
        "PORCUPINE the confidence: 'when you call them, what's your plan when they ask for a full financial disclosure on a recorded line?'",
        "Offer the diagnostic: 'let us pull transcripts first — then you'll know if it's a DIY case or not.' Low commitment, real value, and it advances to sensitive info.",
      ],
      lines: [
        "If this were one year and a small balance, I'd tell you to handle it yourself — honestly. Multiple years with a levy notice? That's when people calling the IRS alone say things that cost them.",
        "Here's a middle path: we pull the transcripts and tell you exactly what you're facing. If it's simple, you'll know. If it's not, you'll be glad you didn't call them solo.",
      ],
    },
  },
  {
    key: "obj_already_have_cpa",
    label: "Already represented — CPA / attorney / another tax company",
    priority: 84,
    keywords: [
      "my cpa", "my accountant", "have an accountant", "accountant handles", "my lawyer",
      "have an attorney", "my tax guy", "my tax lady", "tax preparer handles",
      // Incumbent national resolution firms — same objection family, different play.
      "already working with a company", "another company is handling", "signed up with another company",
      "already with a tax company", "someone is already handling", "already have representation",
      "working with another firm", "already hired someone",
      "optima", "tax defense network", "community tax", "anthem tax", "larson tax",
      "precision tax", "tax hardship", "instant tax solutions", "jackson hewitt",
    ],
    playbook: {
      read: "Comfortable delegation — but the notices and the inquiry say the current setup isn't covering it. Two sub-cases: a CPA/preparer (may not distinguish preparation from REPRESENTATION) vs a national resolution firm already engaged (often months in, thousands paid, nothing visible happening — quiet buyer's remorse they haven't admitted yet).",
      reframe: "The audit question that opens everything: WHAT have they done for you recently, for HOW MUCH you paid them? Loyalty isn't the test — recent, verifiable work for the money is.",
      moves: [
        "Run the value audit, not an attack: 'what did you pay, and what's the last thing they actually did?' Questions about progress don't trigger defensiveness; attacks do.",
        "OIC reality check: if the incumbent filed (or promised) an Offer in Compromise without a real financial basis, it is NOT getting approved — say so plainly. False-hope OICs are the industry's signature move and naming it builds instant credibility.",
        "Contrast with how WE operate: paid-and-silent-for-months is not normal here — name the first-30-days actions (POA filed, transcripts pulled, case manager assigned, compliance read delivered) as the standard they should be getting anywhere.",
        "Isolate and advance: 'if you knew they'd stalled, would you want this actually moving? Let's pull your transcripts and see what's really been done on your file.'",
        "CPA case: different specialty (preparation vs representation) — work WITH the preparer, advance to the transcript pull.",
      ],
      lines: [
        "Fair question for them, not for me: what did you pay, and what's the last thing they did on your file? If you have to think about it, that's the answer.",
        "If they filed an offer in compromise without doing a full financial workup, I'll tell you right now — the IRS is going to reject it. That's not pessimism, that's how OICs work. Paying thousands to wait on a rejection isn't representation.",
        "Here's what those dollars should be buying anywhere: POA on file week one, transcripts pulled, a named case manager, and a plan you can repeat back. You should have all four. Do you?",
        "Keep your CPA for the returns — this is the collections side, different license. Let's pull your transcripts and see where your file actually stands.",
      ],
    },
  },
  {
    key: "obj_burned_before",
    label: "Already paid someone / got burned before",
    priority: 87,
    keywords: [
      "already paid someone", "paid another company", "got burned", "last company",
      "took my money", "did nothing", "tried this before", "went through this already",
      "previous firm",
    ],
    playbook: {
      read: "The hardest trust state: they did the right thing once and got robbed. Anger is at the LAST firm, not you — but you inherit the burden of proof.",
      reframe: "Their experience is data, not a verdict — and it makes them an EDUCATED buyer who can now ask the right questions.",
      moves: [
        "Take their side completely — ask what happened and listen longer than feels efficient. The retelling discharges the anger.",
        "FEEL-FELT-FOUND is built for this one: I get how you feel / half the people we help felt exactly that after their first firm / what they found was the difference is verifiable work in the first 30 days.",
        "Differentiate with process transparency: name the first three concrete actions and dates, in writing.",
        "Smaller first commitment than usual — earn the rest.",
        "Ask what the last firm DIDN'T do — then address those exact gaps explicitly.",
      ],
      lines: [
        "That's infuriating, and it's exactly why this industry has the reputation it does. What did they actually do before things stalled?",
        "Here's how you protect yourself this time: everything we do in the first 30 days is specific and verifiable — transcripts, POA on file, compliance read. You'll see each one happen.",
      ],
    },
  },
  {
    key: "obj_send_email",
    label: "Just send me something / email me the info",
    priority: 80,
    keywords: [
      "send me an email", "email me", "send me something", "send me the information",
      "mail me something", "send it in writing", "send me details",
    ],
    playbook: {
      read: "Polite exit ramp — emails to cold prospects convert near zero. But refusing reads as evasive. Agree AND keep the call alive.",
      reframe: "The email is a commitment device, not the conversation — agree instantly, then make the email WORTH something by extracting one more discovery beat.",
      moves: [
        "Agree immediately, confirm the address — momentum preserved.",
        "While 'pulling it up': one or two discovery questions ('so I send the right thing — is this IRS, state, or both?').",
        "Put a callback ON the email: 'it'll have a time on it — does Thursday morning work to walk through it?'",
      ],
      lines: [
        "Happy to. While I pull that up — so I send the right version — is this just IRS, or is the state involved too?",
        "It'll be in your inbox in an hour, and I'll put Thursday 10am on it to walk through questions. Fair?",
      ],
    },
  },
  {
    key: "obj_how_got_number",
    label: "How did you get my number / I never signed up",
    priority: 86,
    keywords: [
      "how did you get my number", "how did you get my information", "never signed up",
      "didn't sign up", "don't remember signing", "where did you get my info",
      "who gave you my number",
    ],
    playbook: {
      read: "Legitimacy gate, usually in the first 30 seconds. They literally may not remember a 2am form fill. Specificity is the ONLY working answer — vagueness confirms 'scam.'",
      reframe: "You have receipts: the source, the date, the partial email. Delivering them calmly IS the trust-builder.",
      moves: [
        "Answer with the actual opt-in data: source + date + partially-masked email or address.",
        "Then bridge immediately to their issue — don't linger in the defensive register.",
        "If they still don't recall and object, honor removal cleanly (TCPA) — fast and unbothered.",
      ],
      lines: [
        "You filled out a tax-relief inquiry on the 4th — it came in under j***@gmail. That's why I'm calling and not a robot. The form mentioned back balances — is that still live?",
      ],
    },
  },
  {
    key: "obj_busy_bad_time",
    label: "I'm busy / driving / at work",
    priority: 82,
    keywords: [
      "i'm busy", "im busy", "bad time", "at work right now", "i'm driving", "im driving",
      "in a meeting", "can't talk right now", "cant talk now", "call me later", "call me back",
    ],
    playbook: {
      read: "Often literally true — and the most abused dodge. The differentiator: a real busy person will take a SPECIFIC callback; a dodger wants vagueness.",
      reframe: "Don't fight for minutes they don't have — convert the moment into a scheduled, expected call.",
      moves: [
        "Offer the 90-second version OR a precise window: 'two options — 90 seconds now, or 4:30 today. Which?'",
        "Get a micro-commitment before release: confirm the number and one fact ('is the balance still around 30?').",
        "Log and ACTUALLY call at the time — punctuality is the trust play.",
      ],
      lines: [
        "Ninety seconds or I call you at 4:30 — your pick.",
        "Done — 4:30 it is. One thing so I'm ready: is this just the 2021 balance, or multiple years?",
      ],
    },
  },
  {
    key: "obj_guarantee_seeking",
    label: "Can you guarantee a settlement / pennies on the dollar",
    priority: 83,
    keywords: [
      "guarantee", "pennies on the dollar", "settle for less", "promise me",
      "how much will i save", "guaranteed savings", "wipe it out", "make it go away",
    ],
    playbook: {
      read: "They've absorbed the ads. A guarantee request is a TRAP — promising triggers compliance issues and sets up the exact disappointment they fear.",
      reframe: "Refusing to guarantee IS the credibility move — only liars guarantee IRS outcomes. Replace the guarantee with a process they can hold you to.",
      moves: [
        "Name it directly: 'anyone who guarantees you a number before seeing transcripts is lying — that's the ad-speak that burned people.'",
        "Replace with what IS guaranteed: actions, timelines, representation posture.",
        "Use qualification language: 'what I can tell you after we see transcripts is which programs you actually qualify for.'",
      ],
      lines: [
        "If someone promises you pennies on the dollar on a first phone call, hang up on them. What I'll commit to is this: within two weeks you'll know exactly what you qualify for, from your actual transcripts.",
      ],
    },
  },
  {
    key: "obj_no_urgency_sleeping_giant",
    label: "IRS hasn't bothered me / it can wait",
    priority: 89,
    keywords: [
      "haven't heard from them", "havent heard from them", "they haven't done anything",
      "they havent done anything", "haven't bothered me", "havent bothered me",
      "been sitting there for years", "nothing's happened", "nothings happened",
      "no rush", "it can wait", "deal with it later", "deal with it next year",
      "haven't garnished", "havent garnished", "not worried about it",
    ],
    playbook: {
      read: "The sleeping-giant case: they owe, nothing hurts yet, so the debt feels theoretical. IRS silence is processing lag, not forgiveness — and quiet is the most EXPENSIVE phase: maximum penalty/interest accrual, zero leverage being built.",
      reframe: "Enforcement arrives in waves, triggered by data events they can't see coming — a new W-2, a 1099 filing, a refund claim, a state data share. The best outcomes in this business are negotiated BEFORE a revenue officer owns the file; waiting hands the timing to the IRS.",
      moves: [
        "Math the silence: penalties and interest since the balance year — the bill grew every quiet month. Make the growth concrete, not abstract.",
        "Name the triggers: new employer W-2, a 1099 hitting the system, filing for a refund, state-federal data sharing — any one wakes the file. They don't get a warning, they get a levy notice.",
        "Unfiled years: the IRS eventually files FOR them (SFR — substitute return), single, zero deductions, worst possible math. Silence is when that clock runs.",
        "TAKEAWAY with the honest nuance: sometimes waiting IS the strategy (collection statutes expire) — but knowing whether THAT applies requires the exact CSED dates, which live on transcripts. Either way, the next step is the same: pull them.",
      ],
      lines: [
        "Them being quiet isn't them forgetting — it's them adding penalties while you wait. The bill's growing in the dark.",
        "Here's the part nobody says out loud: the best deals get cut before a revenue officer picks up the file. Right now you have every option. After the first levy notice, you have fewer.",
        "Honestly, for some people waiting is the right move — collection windows expire. Want to know if that's you? The expiration dates are on your transcripts. Let's pull them and find out which case you are.",
      ],
    },
  },
  {
    key: "obj_already_on_payment_plan",
    label: "Already on a payment plan with the IRS",
    priority: 85,
    keywords: [
      "payment plan", "installment agreement", "paying them monthly", "already paying the irs",
      "on a plan with the irs", "making payments", "set up payments", "monthly payments to the irs",
      "already worked something out",
    ],
    playbook: {
      read: "They think it's handled — that's the trap. Most self-negotiated installment agreements are set wrong: penalties and interest keep accruing inside the plan, the payment sometimes doesn't even cover the accrual, and one missed month defaults the whole thing. They also likely never checked whether they qualified for something cheaper (abatement, hardship status, an offer).",
      reframe: "A payment plan isn't resolution — it can be a treadmill. The test isn't whether they're paying; it's whether the balance is actually going DOWN, and whether the IRS quietly let them overpay for years.",
      moves: [
        "Run the treadmill test: 'is the balance lower today than the day you set it up?' If it grew or barely moved, that single fact carries the whole conversation — let them say it out loud.",
        "Abatement check: most self-set plans never pursued first-time penalty abatement — money already paid that may be recoverable. The IRS doesn't volunteer it.",
        "Qualification check: when they set it up alone, nobody screened them for hardship status or an offer — the IRS accepts what you agree to, not what you qualify for.",
        "Default-risk frame: one missed payment unwinds the plan and restarts enforcement — representation builds the version that survives a bad month.",
        "Advance: transcripts show the accrual math, the CSED dates, and what they actually qualify for — pull them and grade the plan they're in.",
      ],
      lines: [
        "Quick test: is the balance lower today than the day you set that plan up? If you're not sure — that's the answer, and it's worth ten minutes.",
        "When you set it up yourself, did anyone check whether you qualified for hardship status or penalty abatement first? The IRS takes what you offer — they don't mention the cheaper doors.",
        "A plan that doesn't outrun the interest isn't a plan, it's rent. Let's pull the transcripts and grade the one you're in.",
      ],
    },
  },
  {
    key: "obj_early_price_probe",
    label: "How much does it cost (early, before scoping)",
    priority: 79,
    keywords: [
      "how much does it cost", "how much do you charge", "what do you charge",
      "what does this cost", "what's this going to cost", "whats this going to cost",
      "how much is this", "what are your fees", "what would this run me",
      "how much are we talking",
    ],
    playbook: {
      read: "A BUYING SIGNAL wearing an objection's clothes — nobody asks the price of something they don't want. It dies two ways: dodging (reads evasive, confirms scam fears) or quoting a number before scoping (anchors wrong and invites comparison shopping).",
      reframe: "Respect the question, refuse the false precision: fees follow diagnosis like any professional service. Give the SHAPE — a small fixed investigation phase, then resolution priced off what the transcripts show — and convert the question into the scoping it depends on.",
      moves: [
        "Acknowledge it as fair and serious — never deflect with 'we'll get to that.' Evasion on price undoes every trust move made so far.",
        "Give the honest structure: phase one (POA, transcripts, compliance read) is fixed and modest; the resolution phase is priced by years involved and program qualification — two things not yet known.",
        "PORCUPINE the dependency: 'the price hangs on exactly two things — how many years, and whether enforcement is active. Which are we dealing with?' The price question becomes the discovery engine.",
        "Never apologize for fees, never discount unprompted, never quote the full engagement blind.",
      ],
      lines: [
        "Fair question, and I won't dance around it. The first phase — power of attorney, your transcripts, a full read of where you stand — is fixed and small. The fix itself gets priced off what we find, same as a contractor can't quote a roof he hasn't seen. So: how many years are we talking?",
        "I'll give you a real number the minute I know two things — how many years, and whether there's a levy in motion. Which one should we nail down first?",
      ],
    },
  },
  {
    key: "obj_too_complicated_despair",
    label: "My case is hopeless / too far gone",
    priority: 81,
    keywords: [
      "too far gone", "hopeless", "no one can help", "too complicated", "beyond help",
      "years of this", "such a mess", "too late for me", "buried",
    ],
    playbook: {
      read: "Not an objection — a confession. Shame and avoidance built over years. They expect judgment; the absence of judgment is the whole sale.",
      reframe: "Mess is the firm's daily diet — their 'worst case ever' is a Tuesday. Normalize hard, then shrink the problem to one first step.",
      moves: [
        "Normalize with specificity: 'we had a client with nine unfiled years and a levy — that's a normal intake here.'",
        "Zero judgment language about the years of avoidance — they're braced for it; its absence builds instant trust.",
        "Shrink to ONE step: transcripts. Not the mountain — the first rock.",
      ],
      lines: [
        "I've got news for you — 'six years unfiled and scared to open the mail' is half the people we help. You're not the worst case I've heard this WEEK.",
        "Forget the whole mess for a second. Step one is one signature that lets us see what the IRS sees. That's it. Everything else comes after.",
      ],
    },
  },
]);

// Context-rule-catalog shape (key/label/family/priority/keywords/guidance) so
// the playbook rides the existing deterministic matcher unchanged.
function buildObjectionRules() {
  return OBJECTION_PLAYBOOK.map((entry) => ({
    key: entry.key,
    label: entry.label,
    family: entry.family || "objection_playbook",
    priority: entry.priority,
    keywords: entry.keywords,
    guidance: entry.playbook.reframe,
    summary: entry.playbook.read,
  }));
}

function getObjectionPlaybook(key) {
  return OBJECTION_PLAYBOOK.find((entry) => entry.key === key) || null;
}

// Composer block for matched objections: the SPECIFIC overcoming strategy.
// Rendered into the user message only when an objection fired this turn.
function formatObjectionPlaybookForPrompt(matchedKeys = [], { maxEntries = 2 } = {}) {
  const entries = matchedKeys
    .map((key) => getObjectionPlaybook(key))
    .filter(Boolean)
    .slice(0, maxEntries);
  if (!entries.length) return "";
  // COMPLIANCE PREEMPTION: a DNC/revocation match is terminal — the directive
  // goes out ALONE. No advance-doctrine, no overcome plays, no other entries.
  const dnc = entries.find((entry) => entry.family === "compliance_dnc")
    || matchedKeys.map((key) => getObjectionPlaybook(key)).filter(Boolean).find((entry) => entry.family === "compliance_dnc");
  if (dnc) {
    return [
      "COMPLIANCE — DO-NOT-CALL REVOCATION DETECTED. This is terminal, not an objection.",
      "Coach the agent to confirm removal immediately and end the call professionally. Do NOT suggest any re-engagement, value statement, or question.",
      `- Why: ${dnc.playbook.read}`,
      `- Do: ${dnc.playbook.moves.join(" | ")}`,
      `- Line: ${dnc.playbook.lines.join(" / ")}`,
    ].join("\n");
  }
  return [
    OBJECTION_DOCTRINE,
    ...entries.map((entry) => [
      `Objection detected: ${entry.label}`,
      `- What's really going on: ${entry.playbook.read}`,
      `- Reframe: ${entry.playbook.reframe}`,
      `- Plays (in order): ${entry.playbook.moves.join(" | ")}`,
      `- Example lines (adapt, never read verbatim): ${entry.playbook.lines.join(" / ")}`,
    ].join("\n")),
  ].join("\n");
}

module.exports = {
  OBJECTION_PLAYBOOK,
  buildObjectionRules,
  getObjectionPlaybook,
  formatObjectionPlaybookForPrompt,
};
