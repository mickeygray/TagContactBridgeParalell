import type { ManualEntry } from "./types";

export const STRATEGY_PLAYS_ENTRIES: ManualEntry[] = [
  {
    id: "strat.calm-urgency",
    part: "strategies",
    section: "plays",
    title: "Calm urgency",
    aliases: [
      "levy pressure",
      "garnishment call",
      "real deadline",
      "enforcement urgency",
      "steady voice under pressure",
    ],
    lead: "When enforcement is real — a levy, a garnishment, a final notice — the urgency belongs to the situation, not to you. Acknowledge the risk in a steady voice, confirm what is actually happening right now, and move into facts and representation without promising to stop anything.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect says the words that mean the IRS is already moving: levy, lien, garnishment, frozen account, revenue officer, “they’re taking my paycheck,” “final notice.” This is the one moment in the call where urgency is honest — the collections ladder has a real clock and penalties genuinely compound (see [[tax.collections-ladder]]). Your job is to carry that urgency without adding alarm on top of it. A scared prospect who hears a scared-sounding agent hangs up or freezes; a scared prospect who hears a calm one leans in.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Three beats. First, acknowledge the risk plainly — no minimizing, no dramatizing. Second, confirm whether enforcement is active right now: is money actually coming out of the check, is the account actually frozen, or is this a notice threatening it. That single distinction changes everything about what happens next. Third, pivot straight into fact-gathering and representation — the notice type, the year, the amount — because the honest answer to “what do we do” is always “we get authorized, we see the file, and we respond.” The urgency comes from the deadline printed on their notice, never from your voice.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Okay — that’s serious, and it’s exactly the kind of thing we handle. First question, and it matters: is money actually being taken right now, or is this the notice saying they intend to?”",
          "“I’m not going to pretend that letter isn’t a real deadline — it is. What I need from you is the notice number and the year, so we’re working from facts and not fear.”",
          "“The situation is urgent. You and I don’t have to be frantic about it — we just have to move. What does the top of the letter say?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Manufacturing urgency that isn’t on the notice — invented deadlines destroy trust and cross the compliance line.",
          "Matching the prospect’s panic. Two alarmed people on one call close nothing.",
          "Promising to stop the levy or garnishment. You can say what we do — file representation, request a hold — never what the IRS will grant.",
          "Any humor at all. When wages or accounts are in play, a joke reads as mockery.",
        ],
      },
      {
        kind: "example",
        weak: "“Oh wow, a garnishment? You need to act TODAY or they will take everything — we can stop that for you, but only if you sign right now.”",
        strong: "“A garnishment means the IRS already escalated, so yes — this has a clock on it. Let’s be precise: is it hitting your paycheck yet, or did you get the notice of intent? Because what our team does first is get authorized on the file and get in front of it — and the sooner that starts, the more room there is to work.”",
        note: "The strong version keeps the urgency — “this has a clock on it” — but the pressure comes from the facts, and the promise is about what WE do, not what the IRS will give.",
      },
      {
        kind: "drill",
        prompt: "Prospect says: “They sent me a final notice of intent to levy and I don’t know what to do.” — what’s your move?",
        answer: "Steady voice, downward inflection. Acknowledge it’s real: “That letter is the IRS telling you they’re about to move — you were right to take it seriously.” Then one control question: “Has anything actually been taken yet, or is this the warning?” Then advance: notice number, tax year, amount — and frame representation as the next step. No promise that anything gets stopped; the honest frame is that responding before the deadline is what creates options.",
      },
      {
        kind: "compliance",
        text: "Honest urgency only: the deadline must exist on their notice. Never promise a levy release, a hold, a dollar amount, or a date — describe what the firm does (files representation, communicates with the agency, requests relief where available), not what the IRS will do.",
      },
    ],
    links: [
      "tax.collections-ladder",
      "tax.levy-garnishment",
      "strat.cost-of-waiting",
      "obj.no-urgency",
      "psych.voss.voice",
    ],
  },
  {
    id: "strat.human-reassurance",
    part: "strategies",
    section: "plays",
    title: "Human reassurance",
    aliases: [
      "scared prospect",
      "overwhelmed",
      "can't sleep over this",
      "steady the person first",
      "fear on the line",
    ],
    lead: "When fear or money pressure is driving the call — “I’m scared,” “I can’t sleep,” “I just lost my job” — steady the person before you advance the sale. One plain human acknowledgment, then one concrete control question. A prospect who feels heard will follow you; one who feels processed will not.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "You hear life pressure, not just tax pressure: rent, kids, medical bills, a layoff, panic, “I’m so overwhelmed I don’t even open the letters anymore.” The tax problem and the fear have fused, and the person cannot process a pitch while they’re in it. Everything you say about programs and fees bounces off until the emotional temperature drops one notch.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Mirror the life pressure back in plain language — their words, not therapy words. “Sounds like this has been sitting on your chest for months” lands; “I hear that you’re experiencing anxiety” does not (see [[psych.voss.labeling]]). Then — and this is the whole trick — immediately ask one concrete question that hands them a piece of control: what the notice says, what year it covers, whether money is coming out yet. The acknowledgment says “I’m a person”; the question says “and this is sortable.” Do not stack three sympathy sentences, do not lecture about how they got here, and do not jump from their fear straight to price — that sequence is exactly what a boiler room sounds like.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“That’s a lot to carry — the job on top of the IRS letters. Let’s take one piece off the pile right now: what does the most recent letter actually say?”",
          "“Sounds like this has been keeping you up. Fair. The good news is this is the kind of problem that gets smaller the moment someone looks at the actual numbers — what year are we dealing with?”",
          "“I’m not going to pile on — you already know it’s serious. Tell me one thing: has the IRS taken anything yet, or are we still ahead of that?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Therapy language — “I hear you,” “I understand how you feel,” “that must be so hard” stacked without a next step reads as scripted.",
          "Lecturing about how they got here or how long they waited. Shame closes mouths.",
          "Rushing straight from their fear to the fee. Steady first, advance second.",
          "Jokes or cleverness. If they’re scared or broke, wit sounds dismissive — warmth only.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says: “I got laid off in March and now the IRS is after me — I can’t sleep, I don’t even know where to start.” — what’s your move?",
        answer: "One plain acknowledgment in their language: “A layoff and IRS letters in the same year — no wonder you’re not sleeping.” Then one control question, not a pitch: “Let’s start with the piece we can grab today — what’s the most recent thing they sent you?” The label steadies them; the question moves the call. Price comes later, after the person is standing again.",
      },
    ],
    links: [
      "psych.voss.labeling",
      "psych.voss",
      "obj.hopeless",
      "obj.cant-afford",
      "strat.tone",
    ],
  },
  {
    id: "strat.permission-legitimacy",
    part: "strategies",
    section: "plays",
    title: "Permission and legitimacy",
    aliases: [
      "who is this",
      "why are you calling me",
      "is this legit",
      "earn the right to ask",
      "opening credibility",
    ],
    lead: "You have not earned the right to ask questions until they know who you are and why you’re calling. Slow down, name yourself, the firm, and the tax signal that triggered the call — then ask permission to verify the issue before you go anywhere near a pitch.",
    blocks: [
      {
        kind: "prose",
        heading: "Legitimacy runs both directions",
        text: "The prospect is entitled to basic public verification, and the firm is entitled to determine whether the prospect is engaging in good faith. Give the public basics cleanly: your first name, firm name, truthful call reason, public website or main line, and that we are not the IRS. Do not turn that duty into an unlimited download of office details, internal structure, staff information, tax tactics, or individualized advice. Deeper disclosure follows reciprocal engagement. The question is not whether they are skeptical; skepticism is normal. The question is whether they also answer ordinary questions and let the exchange move toward their actual tax problem."
      },
      {
        kind: "moves",
        heading: "Phase 1 prospect qualification",
        items: [
          "Ask one ordinary case question after giving the public basics. A legitimate prospect usually gives you something usable in return.",
          "Confirm there is a real tax issue within our scope — a balance, unfiled returns, a notice, collections, or another concrete problem.",
          "Watch the pattern, not one guarded answer. Privacy caution is reasonable; sustained refusal paired with continued information fishing is different.",
          "Test whether they will participate in an interview about the case. If every answer redirects to company details or free tax advice, stop deepening the disclosure.",
          "When good faith is uncertain, offer independent verification through the public website/main line and end cleanly. Do not argue, accuse, bluff, or improvise facts."
        ]
      },
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“Who is this?” “What company?” “Why are you calling me?” “Is this a scam?” The prospect is not objecting to tax help — they’re objecting to a stranger. Every unknown caller starts in the same hole, and the instinct to power through it with pitch energy only digs deeper. Clarity beats charm here: until legitimacy is restored, nothing else you say is being evaluated on its merits.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Four pieces, in order, delivered slowly: your name, the firm, the reason — tied to their actual inquiry or the tax record that surfaced — and then a permission question. The permission ask is the hinge: “Do you have a minute for me to make sure I even have this right?” converts a suspicious listener into someone who said yes to something small. That tiny yes changes the footing of the whole call (see [[psych.cialdini.authority]] for why named credentials carry weight, and [[script.intro]] for the full opening arc). Rushing this beat to “get to the good part” is the single most common way calls die in the first thirty seconds.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Fair question — let me slow down. My name’s ___, I’m with ___, and the reason for the call is the tax inquiry connected to this number. Mind if I take thirty seconds to confirm I’ve even got the right situation?”",
          "“You should ask who’s calling — most people don’t. I’m ___ with ___. You reached out about a tax issue, and before I say anything else, is that ringing a bell?”",
          "“I’ll make this easy to check: firm name, my name, and what we do — and then it’s your call whether we keep talking. Fair?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Dodging the “who are you” question or answering it with a pitch. Evasion confirms the scam suspicion.",
          "Over-apologizing for calling. You have a legitimate reason; state it like one.",
          "Jokes before legitimacy is restored — cleverness from a stranger reads as a con.",
          "Rattling off name and firm at auctioneer speed. Slow is credible; fast is telemarketer.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect answers with a flat, suspicious: “What company are you with and why are you calling me?” — what’s your move?",
        answer: "Slow down and give all four pieces without flinching: name, firm, the specific reason — “you submitted an inquiry about a tax issue” or “a tax record connected to this number” — and then the permission ask: “Can I take thirty seconds to confirm I’ve got the right situation?” Do not pitch a single benefit until they grant it. The permission yes is the first commitment of the call.",
      },
    ],
    links: [
      "obj.who-are-you",
      "obj.how-got-number",
      "obj.are-you-irs",
      "script.intro",
      "psych.cialdini.authority",
    ],
  },
  {
    id: "strat.confident-value-frame",
    part: "strategies",
    section: "plays",
    title: "Confident value frame",
    aliases: [
      "fee confidence",
      "don't apologize for the price",
      "price pushback",
      "stand on the fee",
      "value under fee pressure",
    ],
    lead: "When price pressure hits, answer with confidence and scope: say plainly what the firm does — investigation, representation, cleanup — tie the fee to it, and stop talking. No apologizing, no discounting, no over-explaining. The agent who flinches at their own number teaches the prospect to push.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“How much does this cost?” “That’s expensive.” “What do you charge?” Fee talk is where good calls go to die — not because the number is wrong, but because the agent’s voice changes when they say it. Prospects don’t evaluate the fee in a vacuum; they evaluate how the person saying it seems to feel about it. Hesitation, a rush of justification, or an unprompted “but we can work with you” all broadcast the same message: even the agent isn’t sure it’s worth it.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Tie the cost to the work, in concrete terms: the investigation of what the IRS actually has on file, the representation that puts a licensed team between them and collections, the cleanup of whatever the investigation finds. Say the number the same way you’d say the date — as a fact. Then be quiet ([[strat.silence-after-number]] is the companion move: the first person to speak after the number usually concedes). If they push, the answer is more scope, not less price: what the fee covers, not why it’s forgivable. Over-explaining is its own tell — three sentences of justification sounds like an apology wearing a suit.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“The fee covers the whole first phase: we get authorized, pull what the IRS actually has on you, and map the way out. It’s ___.” (Then silence.)",
          "“I get that it’s real money. So is what the IRS is adding every month you’re unrepresented — the fee buys you a team whose whole job is stopping that bleed.”",
          "“It costs what it costs because of what it is: licensed representation, not a phone consultation. Most of our clients spend more than this in penalties before they ever call us.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Apologizing for the fee, in words or in tone. The firm never apologizes for the fee.",
          "Discounting the moment they push. An instant discount tells them the first number was padded.",
          "Over-explaining — long justifications sound like doubt. State the scope once and hold.",
          "Filling the silence after the number. Say it, then let it sit.",
          "Jokes around money pressure — humor at the fee moment reads as nervousness.",
        ],
      },
      {
        kind: "example",
        weak: "“So, um, the fee is ___, but I know that sounds like a lot, and honestly I might be able to talk to my manager about getting that down for you, because we really want to help…”",
        strong: "“Here’s what the engagement covers: we file representation, we pull your full IRS file, and we build the resolution path from actual records instead of guesses. That’s ___.” (Silence.)",
        note: "The weak version negotiated against itself before the prospect said a word. The strong version priced a defined piece of work and let the number stand — and the silence does the asking.",
      },
      {
        kind: "compliance",
        text: "Stand on the fee, but keep the value claims honest: describe the work — investigation, representation, cleanup — never a promised outcome, settlement figure, or timeline. “The fee buys the team and the process” is true; “the fee gets you an OIC” is a promise no one can keep.",
      },
    ],
    links: [
      "obj.price-too-high",
      "obj.cant-afford",
      "obj.early-price-probe",
      "script.payment",
      "strat.silence-after-number",
      "psych.cialdini.authority",
    ],
  },
  {
    id: "strat.expert-specificity",
    part: "strategies",
    section: "plays",
    title: "Expert specificity",
    aliases: [
      "sound like a specialist",
      "name the form",
      "prove expertise",
      "credibility through detail",
      "know the next fact",
    ],
    lead: "Specifics are what credibility sounds like. When the situation is complex — payroll tax, 1099 income, an audit, a joint-return mess — prove expertise by naming the next fact that matters: the form, the notice, the process step. Then pivot to why the team needs documents and authorization to go further.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect mentions something with real complexity: 941s and trust fund language, contractor income with no withholding, an audit letter, an ex-spouse on a joint return. This is a fork in the road. The generic agent responds with generic sympathy — “oh, we handle that all the time” — and sounds exactly like the last robocall. The specialist responds by asking the precise next question a specialist would ask, and the prospect’s posture changes mid-sentence.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Name the thing. If it’s payroll, ask about quarters and whether trust-fund or responsible-person language has appeared ([[tax.payroll-941-tfrp]]). If it’s unfiled years, ask which years and what income type ([[tax.unfiled-sfr]]). If it’s an audit, ask which document arrived — an exam letter, an underreporter notice, a proposed assessment. Knowing WHICH question to ask is the credential; no diploma on a wall does it better. Then pivot honestly: “That’s exactly why the first step is authorization — I can ask good questions, but the team needs to see the actual file ([[tax.representation]]).” One caution: this play proves expertise, it doesn’t practice law on the phone. Name facts and process steps, never conclusions about their liability.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“941s — okay, that changes the questions. Which quarters, is the business still operating, and has anyone used the words ‘trust fund’ or ‘responsible person’ with you yet?”",
          "“1099 income with no withholding — that’s the most common way people end up here, and it’s also the most fixable. How many years, and did anyone ever count your expenses?”",
          "“That sounds like a CP2000 — the computer-matching notice, not a full audit. Different animal, different response. What’s the number in the top corner of the letter?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Generic sympathy where a specific question belongs — “we deal with that all the time” proves nothing.",
          "Faking a specific you’re not sure of. One wrong form number costs more credibility than ten right ones earned.",
          "Solving the case on the phone. Specificity earns the right to say “the team needs the file,” not to render verdicts.",
          "Jokes about complex or embarrassing facts — confidence carries the warmth here.",
        ],
      },
      {
        kind: "example",
        weak: "“Payroll taxes, wow, yeah, those are tough. But don’t worry — we help business owners all the time and I’m sure we can figure something out for you.”",
        strong: "“Payroll is its own world — the IRS treats withheld employee money differently from your own income tax, and that’s where trust-fund penalties come from. So: which quarters are open, and is the business still running? Those two answers decide what the team looks at first.”",
        note: "The weak version could be read off any call floor in America. The strong version demonstrates the map — and ends by advancing the call, not by admiring the problem.",
      },
    ],
    links: [
      "tax.payroll-941-tfrp",
      "tax.unfiled-sfr",
      "tax.representation",
      "obj.how-can-i-trust",
      "psych.cialdini.authority",
    ],
  },
  {
    id: "strat.shame-reduction",
    part: "strategies",
    section: "plays",
    title: "Shame reduction",
    aliases: [
      "embarrassed prospect",
      "years behind on filing",
      "i messed up",
      "normalize without minimizing",
      "keep dignity intact",
    ],
    lead: "Tax debt carries shame the way medical debt carries fear. When you hear “I’m embarrassed,” “it’s my fault,” “I haven’t filed in years” — normalize without minimizing. Keep their dignity intact and the disclosure keeps flowing; let shame into the room and they start hiding facts you need.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "Unfiled years, a mess tangled up with an ex-spouse, or the flat confession: “I know it’s my fault, I just kept putting it off.” Shame is the quietest call-killer there is — it doesn’t hang up, it just stops telling you things. A prospect protecting their dignity will understate the years, forget the second notice, and skip the income they’re embarrassed about. Every fact they withhold is a surprise the team finds later.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Two moves that must happen together. First, normalize honestly — not “it’s no big deal” (it is, and they know it), but “you’re describing the most common situation we see, and people come back from further behind than this.” Naming the feeling before they do also works: “most people in your spot are half-expecting a lecture” is an accusation audit that defuses the dread (see [[psych.voss.accusation-audit]] and [[psych.voss.labeling]]). Second — immediately — make it feel sortable. Shame shrinks when the mess becomes a checklist: which years, what kind of income, what notices have arrived. The pivot from feeling to inventory is the whole play: you’re not excusing the past, you’re making it processable.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You’re not going to shock me — behind on filing is the number one thing we see, and nobody’s ever the furthest behind we’ve helped. Let’s just count it: how many years are we talking?”",
          "“Nobody wakes up planning to fall behind. Life happened, and now we sort it. First question: W-2 income, 1099, or a mix?”",
          "“You probably expected a lecture. Not from me — my only job is the list: years, income type, and whatever letters have shown up.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Minimizing — “it’s really not a big deal” tells them you don’t grasp their situation.",
          "Moralizing or asking WHY they didn’t file. The reason doesn’t change the fix, and the question reopens the wound.",
          "Piling on urgency while they’re mid-confession. Shame plus pressure equals a hang-up.",
          "Any humor where they could possibly be the punchline. Gentle warmth, never a joke about them.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says, voice dropping: “Honestly… I haven’t filed in six years. I know how bad that sounds.” — what’s your move?",
        answer: "Normalize without excusing, then pivot to inventory in the same breath: “It sounds like a person life got on top of — which is most of the people we help, and six years is very much inside the range we clean up. So let’s make it sortable: those six years, was that W-2 work, self-employment, or both?” The disclosure just got easier, and the call just moved forward.",
      },
    ],
    links: [
      "psych.voss.labeling",
      "psych.voss.accusation-audit",
      "tax.unfiled-sfr",
      "obj.hopeless",
      "strat.pain-funnel",
    ],
  },
  {
    id: "strat.state-to-irs-screen",
    part: "strategies",
    section: "plays",
    title: "State-to-IRS screen",
    aliases: [
      "state tax mention",
      "FTB letter",
      "franchise tax board",
      "screen for federal",
      "state vs IRS",
    ],
    lead: "A state-tax mention is a screening opportunity, not the whole story. Where there’s a state problem there is very often a federal one — usually larger — sitting behind it. Separate the state symptoms from the IRS symptoms, then screen for federal balances or unfiled years before anchoring the call on state-only help.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect leads with the state: an FTB letter, a state lien, “the state is garnishing me,” a department-of-revenue notice. It’s vivid to them because it’s the letter in their hand. But state and federal tax problems travel together — the same unfiled years, the same underreported income, the same rough stretch produced both — and the federal side is usually where the larger balance and the larger resolution value live. An agent who over-anchors on the state letter can run a whole call and miss the bigger case entirely.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Take the state issue seriously — it’s real, it’s theirs, and dismissing it loses the call. Then draw the line explicitly: state and IRS are different agencies with different letters and different collections machinery, and problems with one are a strong signal to check the other. The screen itself is two questions: does the IRS say you owe anything, and are there any federal years unfiled? Ask them as natural due diligence — “while we’re looking at this, let’s check the other side of the street” — and the answer routes the rest of the discovery (see [[script.discovery]]). If the federal side comes back clean, you’ve lost nothing; if it doesn’t, you just found the real case.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“The state letter is real and we’ll deal with it — but state and IRS run on separate tracks, and they usually travel together. Has anything shown up from the IRS side? Any federal balance or unfiled years?”",
          "“Quick but important distinction: is that letter from the Franchise Tax Board or from the IRS? Different agency, different playbook — and I want to make sure we’re not fixing the smaller of two problems.”",
          "“Most people who hear from the state hear from the feds within the year. Let’s check now while we’re already looking — anything federal outstanding?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Anchoring the whole call on state-only help because that’s the letter they mentioned first.",
          "Dismissing the state issue to chase the federal one — take it seriously, then broaden.",
          "Assuming they know the difference between agencies. Most don’t; the clarity itself builds credibility.",
          "Getting clever about the confusion — state/federal muddle needs a clear map, not personality.",
        ],
      },
    ],
    links: ["script.discovery", "tax.unfiled-sfr", "tax.collections-ladder", "strat.value-audit"],
  },
  {
    id: "strat.next-phase-control",
    part: "strategies",
    section: "plays",
    title: "Next-phase control",
    aliases: [
      "own the itinerary",
      "name the next step",
      "phase discipline",
      "move the call forward",
      "one phase at a time",
    ],
    lead: "End every beat of the call by naming the next step. The agent owns the itinerary: identify the issue, discover the pain, prove expertise, gather the facts — one phase at a time, each one closed by saying out loud what happens next. A call that drifts belongs to nobody.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "This one fires everywhere — it’s less a situational play than the spine the other plays hang on. Any time a beat resolves — an objection settles, a fact lands, a fear steadies — there is a fork: either you name what comes next, or the call floats. Floating calls get filled by the prospect’s anxiety, tangents, or the classic “well, let me think about it and call you back.” The prospect doesn’t know the route to a resolved tax problem. You do. Acting like it is a service to them, not pressure on them.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Know which phase you’re in — the arc in [[script.method]] — and move the call exactly one phase forward at a time. Not two: an agent who leaps from first pain straight to the close feels grabby, and an agent who tries to solve the whole case inside one answer gives away the consultation and kills the reason to engage. The mechanical habit is the transition sentence: every answer you give ends with the next question or the next named step. “That’s the notice, good — now here’s what I need next.” “That covers the years; the next step is a quick look at income.” Most prospects relax when someone competent is clearly driving; for those callers, the itinerary IS the reassurance.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Good — that answers the notice question. Next thing I need is the years involved, and then I’ll tell you exactly what happens after that.”",
          "“Here’s where we are: issue identified, and I understand what it’s costing you. The next step is simple — I take a few facts down, and the team turns them into a real answer.”",
          "“Before we hang up, here’s the plan in one breath: you find that letter, we talk at two o’clock, and I walk you through what the team needs. Fair?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Ending an answer with silence and hoping the prospect steers. They’ll steer to “let me think about it.”",
          "Skipping phases — pitching before pain, closing before credibility. Each unearned jump costs trust.",
          "Solving the case on the call. You’re proving the route exists, not driving it for free.",
          "Naming a next step and then not enforcing it. A stated itinerary that evaporates trains them to ignore you.",
        ],
      },
      {
        kind: "example",
        weak: "Agent answers a question about the process thoroughly… then trails off. Prospect: “Okay, well, thanks for the info — let me look into it and I’ll give you a call back sometime.”",
        strong: "Agent answers the same question, then without a pause: “So that’s how the process runs. The step for you and me right now is smaller — I need the notice number and the years, and that’s what turns this from a maybe into a plan. What does the top of the letter say?”",
        note: "Same information, opposite outcomes. The weak call handed the itinerary to the prospect; the strong one closed the beat by naming the next step and asking for it in the same breath.",
      },
    ],
    links: [
      "script.method",
      "strat.commitment-language",
      "psych.sandler.upfront-contract",
      "obj.need-to-think",
    ],
  },
  {
    id: "strat.light-warmth",
    part: "strategies",
    section: "plays",
    title: "Light warmth — when it’s allowed",
    aliases: [
      "humor rules",
      "when to be warm",
      "small talk on calls",
      "softener",
      "personality on the phone",
    ],
    lead: "A brief human softener makes you sound alive instead of scripted — but only when the prospect is genuinely calm, and it must pivot to the next useful fact immediately. Under enforcement, fear, money pressure, fee talk, distrust, or anger, the same warmth reads as mockery.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect is relaxed and self-deprecating about the situation itself — “taxes are ridiculous,” “what a mess I’ve made,” “I hate this stuff” — and none of the pressure conditions are live: no levy talk, no fear in the voice, no money strain, no fee discussion, no legitimacy challenge, no objection on the table. That’s a narrow window, and it’s the only window. The test isn’t whether YOU think the moment is light; it’s whether THEY just demonstrated it is.",
      },
      {
        kind: "prose",
        heading: "How the play works — and why the boundary is the play",
        text: "Dry, low-stakes warmth that agrees with their framing and moves on in the same breath: they called taxes ridiculous, you concur briefly, and the very next clause is a useful question. The pivot is not optional — a softener that lingers becomes small talk, and small talk from a stranger about their tax debt curdles fast. The hard boundary: the joke is never about tax enforcement, never about their debt, never about their fear, and never about them. The situation’s absurdity is fair game; the person in it is not. When in doubt, skip it — a warm tone on a straight sentence does ninety percent of what a joke does with none of the risk (see [[strat.tone]]).",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You’re not wrong — nobody’s ever called the tax code user-friendly. Okay: which years are we untangling?”",
          "“‘A mess’ is the technical term we use too. Good news is messes are sortable — what showed up in the mail first?”",
          "“I hate taxes and it’s my whole job, so you’re in good company. Let’s make them someone else’s problem — what’s the notice say?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Any humor under enforcement, fear, money pressure, fee talk, distrust, or anger — the full no-fly list. There it reads as mockery.",
          "Making the prospect, their debt, or the IRS’s next move the punchline. The situation can be absurd; they can’t be.",
          "Lingering. A softener that doesn’t pivot to a fact in the same breath becomes an agent entertaining himself.",
          "Forcing warmth to “build rapport” on a call that hasn’t earned it. Calm competence IS rapport.",
        ],
      },
    ],
    links: ["strat.tone", "psych.cialdini.liking", "psych.voss.voice"],
  },
  {
    id: "strat.anchor-to-inquiry",
    part: "strategies",
    section: "plays",
    title: "Re-anchor to the inquiry",
    aliases: [
      "i never asked for this",
      "i don't know what you're talking about",
      "didn't sign up",
      "forgot the inquiry",
      "quiet authority",
    ],
    lead: "“I never asked for this” — they forgot the inquiry, or they’re testing you. Don’t get apologetic and don’t over-explain the lead source. Re-anchor with quiet authority to the one thing that matters — they reached out about a tax issue, and you can actually help with it — then pivot straight to the diagnostic. Certainty disarms; pleading does not.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“I didn’t ask for this.” “I don’t know what you’re talking about.” “I never filled anything out.” Sometimes it’s true amnesia — they clicked something at 1 a.m. three weeks ago in a panic and buried it. Sometimes it’s a test: deny everything and see if the caller folds. Either way, the inquiry is your anchor and your license, and it’s what separates you from every robocall they’ve ever gotten. A robocaller has no answer to “I never asked for this.” You do — and how you deliver it decides whether they believe it.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Do not litigate the lead source — explaining web forms and data flows sounds exactly like a scammer covering tracks, and every apologetic syllable confirms their suspicion. Instead, state the anchor once, flatly, with the calm of someone reading a fact off a screen: an inquiry about a tax issue is connected to them, and you can actually help with that. Then pivot immediately to the diagnostic question — “do you owe the IRS, or not?” — Then pivot immediately to the diagnostic question — “do you owe the IRS, or not?” — because the fastest way past “did I sign up” is usually to make the conversation about the thing that made them sign up.. If they genuinely owe, the denial usually evaporates mid-answer; the problem is more interesting to them than the provenance. This pairs with [[strat.permission-legitimacy]] — that play is for honest “who are you” questions; this one is for the denial.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You submitted an inquiry about a tax issue, and I can actually help with that — so let me just ask straight: do you owe the IRS, or not?”",
          "“Fair enough — a lot of people fill these out at midnight and forget by morning. The inquiry’s real, and so is what I do. Is there a balance with the IRS right now?”",
          "“I’m not a random dialer — there’s a tax inquiry connected to you, which is the only reason we’re talking. So, the real question: IRS letters, yes or no?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Apologizing for calling or over-explaining where the lead came from. Pleading reads as guilt.",
          "Arguing about whether they signed up. You will win the argument and lose the call.",
          "Folding at the first denial. One calm re-anchor plus the diagnostic is earned; test it before you retreat.",
          "Humor — they are skeptical, and calm certainty is the disarmer, not cleverness.",
        ],
      },
      {
        kind: "example",
        weak: "“Oh — well, our records show you may have filled out a form online, possibly through one of our partner websites? I’m so sorry if this is a bad time, I can explain how we got your information…”",
        strong: "“There’s a tax inquiry connected to this number — that’s the only reason I’m calling. And honestly, the form matters a lot less than the reason someone fills it out. So: do you owe the IRS, or not?”",
        note: "The weak version put the lead source on trial and volunteered for defendant. The strong one stated the anchor as fact and moved the spotlight to their tax situation — where a real prospect’s attention actually lives.",
      },
      {
        kind: "drill",
        prompt: "Prospect says, irritated: “I never signed up for anything. I don’t know what you’re talking about.” — what’s your move?",
        answer: "No apology, no lead-source lecture. One flat re-anchor and straight to the diagnostic: “There’s an inquiry about a tax issue connected to you — that’s why I’m calling, and it’s the kind of thing I can actually help with. Simple question: is there an IRS balance or unfiled years, or not?” If yes, the denial stops mattering. If a genuine no, thank them and move on — the diagnostic just did its job.",
      },
    ],
    links: [
      "obj.dont-remember-signup",
      "obj.how-got-number",
      "obj.not-interested",
      "script.intro",
      "strat.permission-legitimacy",
    ],
  },
  {
    id: "strat.hostility-resilience",
    part: "strategies",
    section: "plays",
    title: "Hostility resilience",
    aliases: [
      "angry prospect",
      "getting cursed at",
      "stop calling me",
      "don't match their heat",
      "hostile opener",
    ],
    lead: "A hostile tone is a defense, not a final answer — people picking up an unknown tax call are often scared or embarrassed under the anger. Never match their heat: calm, slow, lower register. Acknowledge once, make ONE clean attempt to land the value, and honor a genuine do-not-call instantly.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "You get cursed at, told to get a life, accused of harassment — heat, right out of the gate. Here’s what the corpus and the floor both know: hostility on a tax call is very often armor. The person yelling has a drawer of unopened IRS letters, and the anger is easier to feel than the fear. That doesn’t make the abuse pleasant, but it changes what it means: it’s frequently the last defense before the real objection — and sometimes before the real problem — comes out.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Voice first: flat, steady, slow, register down — the late-night-DJ tone from [[psych.voss.voice]]. Matching their volume confirms you’re the fight they were braced for; staying level makes the anger awkward to sustain against. Then the discipline: acknowledge ONCE — not a stream of apologies, which reads as weakness and invites more heat — and make one clean attempt to land the value: not trying to bother you, you did reach out about a tax issue, that part is fixable — do you owe the IRS or not? One attempt. If the answer is a genuine, unambiguous stop-calling or do-not-call, honor it immediately and disengage — no parting pitch, no “just one more thing.” The play is resilience, not persistence: you don’t flinch, and you don’t overstay.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Understood — not trying to bother you. You did reach out about a tax issue, and that part is fixable. Do you owe the IRS, or not?”",
          "(Slower, lower, after a blast:) “I hear you. One question and I’m gone either way — is there an IRS balance, yes or no?”",
          "(On a clear DNC:) “Understood — I’m removing this number now. You won’t hear from us again.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Matching their heat, arguing, or defending yourself point by point. You cannot win a shouting match and represent the firm at the same time.",
          "Apologizing repeatedly. One acknowledgment; a stream of sorries is blood in the water.",
          "Flinching off the call at the first blast without the one clean value attempt — anger is often the last layer before the real objection.",
          "Making more than one attempt. Resilience is one calm swing, not a siege.",
          "Any humor whatsoever — here it reads as mockery and confirms their worst assumption about you.",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “Stop calling me, you people are vultures!” Agent: “Whoa, sir, there’s no need for that language, I’m just doing my job, you’re the one who filled out the form—”",
        strong: "Prospect: “Stop calling me, you people are vultures!” Agent (level, slower, lower): “Understood — not trying to bother you. You did reach out about a tax issue, and that part’s fixable. Do you owe the IRS, or not?” Prospect, after a beat: “…I mean, yeah, but I can’t deal with this right now.” — and now there’s a real call.",
        note: "The weak agent took the bait and made it personal. The strong agent stayed flat, acknowledged once, and made the single clean attempt — and the armor cracked into the actual situation.",
      },
      {
        kind: "compliance",
        text: "A genuine, unambiguous “stop calling” or do-not-call request is terminal: honor it instantly, confirm removal, and disengage. No play in this manual applies past a DNC — resilience is for hostility, never for revocation.",
      },
    ],
    links: [
      "obj.dnc-revocation",
      "obj.not-interested",
      "psych.voss.voice",
      "strat.tone",
    ],
  },
  {
    id: "strat.loop-in-decision-maker",
    part: "strategies",
    section: "plays",
    title: "Loop in the decision maker",
    aliases: [
      "talk to my wife",
      "ask my husband",
      "check with my spouse",
      "we file jointly",
      "get them on the phone",
    ],
    lead: "“I have to talk to my spouse” loses the deal not because the spouse says no, but because your pitch dies in translation. Affirm that looping them in is smart, then work to get them on THIS call — or keep gathering facts now so the conversation they have is an informed one. A retold pitch almost always loses.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“My wife handles the money.” “I need to run it by my husband.” “We file jointly, so it’s both of us.” Sometimes it’s a genuine decision structure — and on a joint return the spouse literally IS a party to the problem. Sometimes it’s a polite exit wearing a wedding ring. Either way, the math is brutal: tonight over dinner, your forty-minute consultation becomes “some tax company called today.” Every number is fuzzy, every credential is gone, and the spouse — who owes their partner the protective answer — says “sounds like a scam.” The pitch you don’t deliver yourself almost always loses.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Never fight the spouse — affirm the instinct immediately: involving them is smart, and on a joint filing it’s necessary. That affirmation buys you the standing for the real move, which is one of two asks in order of preference. Best: get them on this call — “Is she around? Grab her, this affects you both, and it’ll save you repeating all this.” A three-minute three-way beats a perfect callback that never happens. If they truly can’t: keep momentum by gathering the facts NOW, framed as arming them for the conversation — “so when you two talk you have the real picture, what notice and year are we looking at?” — and then pin the follow-up to a specific time with both parties expected. What you never do is imply they can’t decide alone; the frame is always “this involves both of you,” never “you need permission.”",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Smart — on a joint return this is both of you anyway. Is she around right now? Two minutes with both of you beats you having to replay all this from memory.”",
          "“Absolutely loop him in. So that conversation is worth having, let’s make sure you’ve got the real picture to bring him — what notice and what year are we looking at?”",
          "“Here’s what I’d hate: you try to re-explain forty minutes of tax law over dinner. Let’s book ten minutes tomorrow with both of you on — what time is he home?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Implying they can’t or shouldn’t decide alone. Affirm the loop-in; never diminish their authority.",
          "Letting “I’ll talk to them” end the call with nothing scheduled. An unpinned callback is a soft no.",
          "Sending them to retell the pitch cold. Arm them with facts, or better, remove the retelling entirely.",
          "Joking about the relationship or who wears the pants. Warmth fine; that joke never lands.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says: “This sounds good, but I have to check with my wife before I do anything.” — what’s your move?",
        answer: "Affirm, then attempt the merge: “Smart — and honestly, if you file jointly this is her situation too. Is she home? Grab her for two minutes and I’ll catch her up, so you’re not stuck re-explaining tax law tonight.” If she’s not available: gather facts now to arm the conversation, then pin it: “Then let’s do this — tomorrow at six, you both on the phone, ten minutes. I’ll have everything laid out so the decision’s easy to make together.”",
      },
    ],
    links: [
      "obj.spouse-consult",
      "obj.need-to-think",
      "strat.dissolve-stall",
      "psych.cialdini.commitment",
    ],
  },
  {
    id: "strat.dissolve-stall",
    part: "strategies",
    section: "plays",
    title: "Dissolve the stall",
    aliases: [
      "let me think about it",
      "call me back later",
      "send me something",
      "not a good time",
      "surface the real concern",
    ],
    lead: "A stall is usually an unvoiced concern wearing a polite mask — “think about it,” “send me something,” “call back later” most often means cost, trust, or “is this even worth it.” Don’t fight the stall and don’t obey it; gently surface which concern is underneath, because you can answer a concern and you can’t answer a fog.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“Let me think about it.” “Just email me the details.” “Now’s not a good time — call me next week.” More often than not, these aren’t answers; they’re exits dressed as delays. The prospect has a real hesitation they haven’t said out loud — usually the cost, whether you’re legit, or a quiet doubt that their problem is bad enough to bother with — and the stall is how they leave without the discomfort of voicing it. Take the stall at face value and you inherit its future: the email goes unread, next week’s call goes to voicemail, and “thinking about it” turns out to mean “stopped thinking about it the moment we hung up.”",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Acknowledge first, then explore — the LAER rhythm. Agree to the surface request cheerfully so there’s nothing to push against: “Happy to follow up.” Then, in the same breath, ask the question that splits the fog into nameable parts: “so I send the right thing — is the hesitation the cost, or whether this is legit?” Offering two candidate concerns does something a bare “why” can’t: it makes admitting a hesitation feel normal, and even a “neither, it’s actually…” hands you the real one. Once it’s named, you’re back on solid ground — a cost concern routes to [[strat.confident-value-frame]], a trust concern to [[strat.earn-trust-with-proof]]. And because tax balances genuinely compound, you can tie waiting to cost honestly and gently — the penalties accrue whether or not they think about it — without ever leaning on manufactured pressure.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Happy to follow up — so I send the right thing, let me ask straight: is the hesitation the cost, or whether this is legit?”",
          "“Of course, think it over. Usually when someone says that, one thing’s nagging at them — what’s the one for you? Price, trust, or whether it’s even worth fixing?”",
          "“I’ll email whatever you want. One honest note first: the balance doesn’t pause while you think — penalties run either way. So tell me what the real question is, and I’ll answer it now for free.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Arguing with the stall — “you don’t need to think about it” creates the fight the stall was avoiding.",
          "Obeying it at face value. An email sent into a fog answers nothing and closes nothing.",
          "Piling on pressure. The probe is gentle by design; pressure re-seals the concern you’re trying to open.",
          "Humor on a hard stall or where money pressure is live. A very dry softener only on a mild one.",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “Just send me some information and I’ll look it over.” Agent: “Sure thing! What’s your email? Great, you’ll have it this afternoon — feel free to reach out with any questions!”",
        strong: "Prospect: “Just send me some information and I’ll look it over.” Agent: “Happy to. So I send the right thing and not a brochure you delete — what’s the piece you actually need to see? Is it what this costs, or proof we’re legit?” Prospect: “…I guess mostly what it costs.” — and now it’s a fee conversation you can actually win.",
        note: "The weak agent obeyed the stall and mailed the deal into a void. The strong one agreed cheerfully, then split the fog — and the prospect named the real concern within one exchange.",
      },
      {
        kind: "drill",
        prompt: "Prospect says: “This all sounds fine, but let me think about it and I’ll call you back.” — what’s your move?",
        answer: "Acknowledge, then surface: “Take the time — it’s a real decision. Before I let you go, though: when someone says ‘think about it,’ it’s usually one specific thing doing the thinking. For you, is it the fee, or whether we’re the real deal?” Whatever they name, answer THAT now. If they insist on time after the concern is addressed, pin the callback to a specific day and hour — an unpinned callback is a soft no.",
      },
    ],
    links: [
      "obj.need-to-think",
      "obj.send-email",
      "obj.busy-bad-time",
      "strat.isolate",
      "strat.cost-of-waiting",
      "psych.voss.calibrated-questions",
    ],
  },
  {
    id: "strat.earn-trust-with-proof",
    part: "strategies",
    section: "plays",
    title: "Earn trust with proof",
    aliases: [
      "sounds like a scam",
      "prove it",
      "look us up",
      "verification beats reassurance",
      "how do I know you're real",
    ],
    lead: "Distrust beyond a simple “who are you” needs proof, not persuasion. Be specific and verifiable — name the firm, the concrete process, the actual authorization forms — and invite them to look you up right now, while you wait. Specifics and calm beat reassurance every time; a scammer can say “trust me,” but can’t say “verify me.”",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“Sounds like a scam.” “You people are all the same.” “Too good to be true.” “Prove it.” This is past the honest curiosity of [[strat.permission-legitimacy]] — they’ve decided to be skeptical, probably because someone in their life already got burned by a fake tax-relief call. Understand what that means tactically: every ounce of persuasion energy you spend now is evidence against you, because pushing is exactly what the scammer did. The skeptic’s test is simple, even if they never say it: a con artist needs you to stay on the line and act on trust; a real firm can afford to be checked.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Drop all pressure — visibly. Then replace reassurance with verifiable specifics: the firm’s actual name, and the concrete process no scammer describes because it doesn’t serve a con — an investigation of their IRS file, authorization through Form 2848, licensed representation between them and collections (see [[tax.representation]]). Then the crown move: invite verification, on the clock, at your expense. “Look us up right now — I’ll wait.” The offer works whether or not they take it; often the willingness IS the proof, and the tension drains before they ever open a browser. If they do check, better still — everything holds up. What you must not do is take the skepticism personally or argue with it. In their shoes, having heard what they’ve heard, you’d run the same check.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Good — you should be skeptical, there are real scams in this space. So don’t take my word for anything: look the firm up right now. I’ll wait on the line while you do.”",
          "“Here’s the difference you can check: a scammer wants a payment today. What we do is file Form 2848 — an IRS power of attorney — pull your actual file, and represent you. Every piece of that is verifiable.”",
          "“No pressure from me — verify first, decide second. What would you need to see to feel solid? Tell me, and that’s where we start.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Answering distrust with more persuasion. Pushing is what the scammer did; pressure is evidence against you.",
          "Vague reassurance — “we’re totally legitimate, trust me” is exactly what a fake firm says. Specifics or nothing.",
          "Taking it personally or getting defensive. Their skepticism is earned by the industry, not caused by you.",
          "Any humor — a skeptical person reads jokes as deflection.",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “How do I know this isn’t a scam?” Agent: “Oh no, sir, I promise we’re one hundred percent legitimate — we’ve helped thousands of people and we’re rated very highly. You can absolutely trust us.”",
        strong: "Prospect: “How do I know this isn’t a scam?” Agent: “You don’t yet — and you shouldn’t on my say-so. Do this: look the firm up right now, while I hold. And here’s the part a scam can’t fake — we get authorized with the IRS directly, a Form 2848 on file with them, before anything else moves. Check both. I’ll wait.”",
        note: "The weak answer is unfalsifiable reassurance — exactly the scammer’s script. The strong one hands over the means of verification and stakes the call on it, which only a real firm can afford to do.",
      },
    ],
    links: [
      "obj.scam-distrust",
      "obj.company-name-verify",
      "obj.how-can-i-trust",
      "tax.representation",
      "psych.cialdini.authority",
    ],
  },
  {
    id: "strat.channel-relief",
    part: "strategies",
    section: "plays",
    title: "Channel relief into action",
    aliases: [
      "oh thank god",
      "you can really help",
      "finally someone",
      "convert the relief",
      "hope on the line",
    ],
    lead: "When relief lands — “oh thank god,” “finally,” “can you really help?” — you’re holding something fragile. Convert it into the next concrete commitment while it’s warm, and do it without over-promising: hope that gets inflated on the phone breaks later, and it breaks on the firm.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect’s voice changes. “I’m so glad you called.” “I didn’t know what to do.” “You can actually help with this?” After months of unopened letters and 2 a.m. dread, someone competent is on the line, and the exhale is audible. Two mistakes live in this moment. The first is riding the emotion into promises — “absolutely, we’ll get this all taken care of, you have nothing to worry about” — which feels kind and is actually a debt the case may not be able to pay. The second is letting the moment pass as mere rapport: relief that isn’t converted cools into “well, let me think about it” within minutes, because hope without a next step defaults back to the paralysis they called from.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Meet the vulnerability sincerely — warmth, no jokes, they’ve just shown you something real. Ground the hope in the firm’s genuine track record stated honestly: “we help people through exactly this every day” is true and steadying, and promises nothing specific. Then, in the same breath, channel the energy into the immediate next concrete step: the notice, the year, the facts — framed as the difference between a real answer and a guess. Relief is motive force; the next step is the rail it runs on. What they’re really asking with “can you really help?” is “is this fixable?” — and the honest, powerful answer is that it’s the kind of problem the firm resolves constantly, and the way to their real answer starts with what’s in their hand right now.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“We help people through exactly this every day — you’re not the furthest behind we’ve seen, not close. To get you a real answer instead of a guess, let’s start with the notice and the year you’re looking at.”",
          "“That feeling — that’s why I do this. Let’s put it to work while you’ve got it: grab the most recent letter. What’s the number at the top?”",
          "“It’s fixable — that’s the honest answer. HOW it gets fixed depends on facts I don’t have yet, so let’s get them: which years, and what’s shown up in the mail?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Inflating the hope — “don’t worry, we’ll take care of everything” is a promise the case hasn’t earned yet.",
          "Letting the moment pass as rapport. Unconverted relief cools into a stall within minutes.",
          "Jokes. They’re being vulnerable; meet it sincerely — warmth yes, cleverness no.",
          "Answering “can you really help?” with a guarantee instead of the honest frame: this is what we do every day, and the real answer starts with the facts.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect, voice cracking with relief: “Oh thank god. I’ve been sitting on these letters for a year — you can really fix this?” — what’s your move?",
        answer: "Sincere warmth, honest grounding, immediate channel: “People sitting on a year of letters is exactly who we help — every single day. I can’t tell you the ending before we see the facts, and anyone who does is lying to you. So let’s start getting your real answer right now: open the most recent one. What’s the notice number at the top?” The relief becomes motion before it can cool.",
      },
      {
        kind: "compliance",
        text: "Relief is where over-promising is most tempting and most damaging. Never promise a result, a settlement figure, or a date — the honest frame is what the firm does (investigates, gets authorized, represents) and that this is the kind of problem it resolves every day. Hope grounded in process holds; hope inflated on the phone breaks on the firm later.",
      },
    ],
    links: [
      "obj.hopeless",
      "strat.commitment-language",
      "psych.cialdini.commitment",
      "strat.next-phase-control",
    ],
  },
  {
    id: "strat.take-the-yes",
    part: "strategies",
    section: "plays",
    title: "Take the yes",
    aliases: [
      "momentum close",
      "stop selling",
      "sign me up",
      "let's do it",
      "move to logistics",
    ],
    lead: "They said yes — stop selling, immediately. Every additional value sentence past a yes re-opens the decision you just won. Move straight to logistics: the next concrete step, what to have in hand, when it happens. Brief, assumptive, in motion.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“Let’s do it.” “Sign me up.” “What do you need from me?” “How do we start?” The decision has been made — and this is, strangely, one of the most dangerous seconds of the call, because the agent’s momentum doesn’t stop when the prospect’s resistance does. There are two more benefits queued up, a great line about the process that hasn’t been used yet, and the instinct to keep validating the choice. Every one of those sentences is a small invitation to reconsider: a yes is a closed door, and each extra value point reaches back and opens it a crack. Prospects have talked themselves out of decisions while the agent was still celebrating them.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Match their energy for exactly one beat — “Perfect.” — then become the person who handles the paperwork: brief, assumptive, already in motion. The register shift is the whole move. Selling voice ends; logistics voice begins: here’s what happens next, here’s what to have in hand, here’s when it happens. Concrete steps do double duty — they get the enrollment done, and they confirm the decision was right, because competence on the details is what a good firm feels like from the inside. This is [[psych.cialdini.commitment]] working for you: each small completed action deepens the yes. And keep the celebration proportional — a victory lap that goes on too long tells the prospect the agent is surprised anyone said yes, and surprise is not what they want to hear from the firm they just hired.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Perfect — here’s what happens next. I need about ten minutes and three things from you: the notice, your filing status, and a card for the engagement. Got the letter nearby?”",
          "“Great decision — and now the easy part’s mine. First step is the authorization paperwork, today; the team starts on your file from there. Let’s knock out the details.”",
          "“Love it. So: today we get you enrolled and authorized, this week the team pulls your IRS file, and then you get real answers. Starting now — spell your legal name for me.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "One more benefit. The pitch is over; every value sentence past the yes re-opens the decision.",
          "Recapping everything they just agreed to “to confirm.” A full recap is a re-decision invitation.",
          "Over-celebrating. One beat of matched energy, then practical — don’t sound surprised they said yes.",
          "Slowing down. Hesitation in the logistics reads as doubt about the deal they just made.",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “Okay, let’s do it.” Agent: “That’s great! And you know, another thing you’re going to love is our client portal — plus, did I mention penalty abatement? A lot of clients qualify, and also our team has decades of—” Prospect: “Actually, you know what, let me talk it over with my wife first.”",
        strong: "Prospect: “Okay, let’s do it.” Agent: “Perfect — here’s what happens next. Ten minutes, right now: I take your details, we get the authorization moving today, and the team starts pulling your IRS file this week. First thing I need is your legal name as it appears on your return.”",
        note: "The weak agent kept selling into an open goal until the prospect found a reason to reconsider. The strong one took the yes, switched registers in a single word, and had them mid-enrollment before the decision could re-open.",
      },
    ],
    links: [
      "strat.buying-signals",
      "script.close",
      "script.payment",
      "psych.cialdini.commitment",
      "strat.answer-the-momentum",
    ],
  },
  {
    id: "strat.answer-the-momentum",
    part: "strategies",
    section: "plays",
    title: "Answer the momentum",
    aliases: [
      "how does this work",
      "how long does it take",
      "what happens next",
      "process questions are buying signals",
      "buying signal",
    ],
    lead: "A process, timeline, or how-does-it-work question is momentum — they’re picturing being a client. Don’t re-pitch value to someone already leaning in. Answer briefly and concretely, then advance to the next commitment as if working together is already the plan. Answer the momentum, not just the words.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "“How does this all work?” “How long does something like this take?” “What happens first?” “Who would I actually be working with?” Read what’s underneath: Read what’s underneath: people rarely ask for the itinerary of a trip they aren’t considering taking.. These questions usually mean the internal movie has started — they’re imagining the process with themselves in it, and they’re checking whether the picture holds up., and they’re checking whether the picture holds up. The question’s literal content is almost secondary; the fact that they asked it is the message.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Two failure modes to dodge. The first is hearing the question as doubt and responding with another value pitch — re-selling someone who is already leaning in is how you talk a buyer back into a shopper. The second is answering so thoroughly that the answer becomes a seminar and the momentum dies of old age. The play: answer briefly and concretely — steps, order, who does what — with the specificity that makes the picture in their head sharper (that’s [[strat.expert-specificity]] in service of a close). Then, without a seam, advance to the next commitment in assumptive language: “…and that first step is one you and I can start right now.” On timeline questions, stay honest: give the shape of the process — investigation first, then the resolution path the facts support — never a promised date. The momentum came from them; your job is to keep it pointed forward.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Good question — three phases. We get authorized and pull your IRS file, the team maps what the facts actually support, then we execute the fix. Phase one starts the day you enroll — which is the part you and I can do right now.”",
          "“Timeline’s honest answer: the investigation runs first, and everything after depends on what it finds — anyone promising a date before seeing your file is guessing. What I can say is when it starts: today, if we get the paperwork moving.”",
          "“You’d work with the resolution team — licensed, and it’s all they do. My job ends when your file lands on their desk. Want me to start the paperwork that gets it there?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Re-pitching value at someone already leaning in. They’re past “why”; dragging them back to it breaks the spell.",
          "The seminar answer. Momentum has a shelf life measured in sentences — brief, concrete, then advance.",
          "Promising timelines or outcomes to feed the momentum. “When it starts” is yours to promise; “when it ends” is not.",
          "Cuteness about the process. They’re probing for certainty — confident warmth fine, jokes undermine it.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says: “So walk me through it — how long does something like this usually take?” — what’s your move?",
        answer: "Recognize the buying signal — they’re picturing the process with themselves in it. Answer concretely and honestly without a promised date: “Investigation first — we get authorized, pull your file, and that’s when guessing stops. How long the full fix takes depends on what it finds, and I won’t invent a date before we’ve seen it. What’s definite is the start: paperwork today, team on your file this week.” Then the assumptive advance: “Want to get that clock started?”",
      },
    ],
    links: [
      "strat.buying-signals",
      "strat.take-the-yes",
      "obj.how-long",
      "script.pitch",
      "strat.commitment-language",
    ],
  },
  {
    id: "strat.mirror-to-open",
    part: "strategies",
    section: "plays",
    title: "Mirror to open",
    aliases: [
      "repeat their last words",
      "mirroring",
      "keep them talking",
      "no hook yet",
      "label the undercurrent",
    ],
    lead: "When the prospect is talking but hasn’t handed you a hook, don’t interrogate — open them. Repeat their last meaningful few words back as a question, or label the undercurrent you hear. People tend to correct and expand on mirrors and labels far more readily than they answer direct questions.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "No strong topic has surfaced yet. They’re circling — half-stories, vague complaints, “it’s just been a whole thing with the taxes” — and you don’t yet know if this is a levy, unfiled years, or a mixup. The interrogation instinct kicks in: fire off discovery questions until something lands. But a stranger asking rapid-fire questions feels like an intake form with a pulse, and guarded people give an intake form the shortest answers they can. What you need is for them to keep talking on their own steam.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Two tools, both borrowed straight from [[psych.voss.mirroring]] and [[psych.voss.labeling]]. The mirror: take their last one-to-three meaningful words and hand them back with a slight upward inflection — “…took everything out of the account?” It works on a quirk of conversation: It works on a quirk of conversation: people tend to experience a mirror as proof of attention, and they usually respond by elaborating, almost involuntarily.. The label: name the undercurrent instead of the content — “sounds like this has been sitting on you for a while.” Start with “it sounds like” or “it seems like,” never “I understand” — a label offers a hypothesis they can correct, which is exactly what you want, because both the confirmation and the correction carry new facts. Then the hard part: silence. The mirror or label is the cast; the quiet after it is the reel. And don’t decorate them — mirrors and labels carry their own warmth, and stacking sympathy on top smothers the effect.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Prospect: “And then last month they just took everything out of the account.” — You: “…took everything out of the account?” (Then silence.)",
          "“It sounds like this has been sitting on you for a while.” (Then let it sit.)",
          "Prospect: “It’s been a nightmare dealing with all of it.” — You: “All of it?” — and they inventory the nightmare for you.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Interrogating — firing discovery questions at someone who hasn’t opened up yet gets you form-length answers.",
          "Mirroring their whole sentence back. One to three meaningful words; a full echo sounds like malfunction.",
          "“I understand” instead of “it sounds like.” One claims their feelings; the other offers a hypothesis they can correct.",
          "Filling the silence after the mirror. The quiet is where the expansion happens — don’t talk over the reel.",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “It’s just been a mess since my husband passed — the taxes got away from me.” Agent: “I’m sorry to hear that. So, how many years are unfiled? Do you have the notices? What was your income during those years?”",
        strong: "Prospect: “It’s just been a mess since my husband passed — the taxes got away from me.” Agent: “…got away from you?” Prospect: “Yeah — he always handled them, and after he died I couldn’t face the paperwork, and now it’s been four years and there’s letters I haven’t even opened.” — years, cause, and notices, all volunteered from one mirror.",
        note: "The weak agent switched to intake mode on a grieving stranger and got a wall. The strong agent handed back three words and got the year count, the reason, and the unopened notices — unprompted.",
      },
    ],
    links: [
      "psych.voss.mirroring",
      "psych.voss.labeling",
      "obj.silence",
      "script.discovery",
    ],
  },
  {
    id: "strat.clarify-without-overfitting",
    part: "strategies",
    section: "plays",
    title: "Clarify without overfitting",
    aliases: [
      "ambiguous answer",
      "not sure what they mean",
      "one clarifying question",
      "don't guess",
      "don't force the pitch",
    ],
    lead: "When you’re not sure what they meant, ask one plain clarifying question — don’t guess and build on the guess. Forcing a tax program, a joke, or a pitch angle the prospect hasn’t earned yet is overfitting: you’re selling to a situation that may not exist.",
    blocks: [
      {
        kind: "prose",
        heading: "The moment it fires",
        text: "The prospect says something that could mean three different things. “They’ve been taking money” — the IRS? An offset? A payment plan they set up and forgot? “I got a letter about my taxes” — a bill, an audit, a refund hold? The temptation is to pick the interpretation that best sets up your pitch and sprint: assume it’s a levy, deploy the enforcement urgency, start framing representation. When the guess is wrong, the cost compounds — the prospect hears an agent responding to a situation that isn’t theirs, and nothing marks you as a script-reader faster. The parallel mistake is emotional: reading a flat “yeah, it’s been fun” as an invitation to joke, or a sigh as devastation, and calibrating your whole tone to a misread.",
      },
      {
        kind: "prose",
        heading: "How the play works",
        text: "Ask one plain question, sized to the ambiguity, before you commit anything to the guess. “When you say they’ve been taking money — is that coming out of your paycheck, or your bank account, or a payment plan you set up?” Ten seconds, and now the next thirty seconds of the call are aimed at their actual situation. The discipline has three parts. One: it’s ONE question — a clarifying question that becomes an interrogation defeats its own purpose ([[strat.mirror-to-open]] is often the lighter tool if they just need room to keep talking). Two: it’s plain — no jargon in the clarifier itself, since the ambiguity often exists precisely because they don’t know the official words for what’s happening to them. Three: nothing gets pitched, joked, or diagnosed until the answer lands. Clarity costs ten seconds; overfitting costs the call. The honest “help me make sure I’ve got this right” also does quiet trust work — it tells them you’re actually listening, not sorting them into a script bucket.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Quick check so I don’t assume wrong: when you say they’ve been taking money — out of your paycheck, your bank account, or a payment plan you set up?”",
          "“Help me make sure I’ve got this right — the letter you got, was it saying you owe, or that they’re changing something on your return?”",
          "“Before I answer, one thing: when you say ‘handled,’ do you mean it’s paid off, or that someone told you they’re handling it?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Guessing the meaning that best sets up your pitch and building on it. A wrong guess marks you as a script-reader.",
          "Clarifying with jargon. They may not know the official name for what’s happening — that’s often WHY it’s ambiguous.",
          "Turning one clarifier into five. One plain question; if they need room instead of questions, mirror.",
          "Forcing a joke or a tone read on an ambiguous signal. No humor until the issue and the emotional state are actually clear.",
        ],
      },
    ],
    links: [
      "script.discovery",
      "strat.mirror-to-open",
      "psych.voss.calibrated-questions",
    ],
  },
];
