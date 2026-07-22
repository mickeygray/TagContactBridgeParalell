import type { ManualEntry } from "./types";

// Part 1 — the script (section: method). The seven-section Tax Group
// representation method, taught as prose. Synthesized from the approved
// representation script, the universal origination script, and the coach's
// phase machine + step checklists. Lines are kept nearly verbatim from the
// approved script — adapt them to your own mouth, never recite them flat.

export const SCRIPT_ENTRIES: ManualEntry[] = [
  {
    id: "script.method",
    part: "script",
    section: "method",
    title: "The call, start to finish",
    aliases: ["the arc", "seven sections", "call flow", "phases", "the method", "call structure"],
    lead: "Every good call walks the same seven-section arc: introduce, build the case, show expertise, pitch representation, present the fee, collect the file, and close. The order is the method — each section earns the right to the next one, and skipping ahead is how calls die.",
    blocks: [
      {
        kind: "prose",
        heading: "The seven sections",
        text: "The approved method runs Introduction → Case Building → Expert Guidance → Representation Pitch → Payment Terms → Information Collection → Closing. That looks like a script, but it is really a trust ladder. In the [[script.intro]] you earn permission to ask questions. In [[script.discovery]] you earn the facts. In [[script.expert]] you spend those facts to prove you understand the case better than the prospect does. Only then does the [[script.pitch]] land, because now representation is the obvious answer to a problem you both can see. The fee in [[script.payment]] is priced against that understood problem, the personal information in [[script.info]] is justified by the fee they just agreed to, and the [[script.close]] locks it all in. Every section is the setup for the one after it."
      },
      {
        kind: "prose",
        heading: "Why the order matters",
        text: "Watch what happens when the order breaks. Quote a fee before representation is framed and the prospect has nothing to anchor the number against — their honest reaction is “wait, what am I paying for?”, which comes out of their mouth as “that’s too expensive.” You created the price objection yourself. Ask for a Social Security number before a fee has landed and you are a stranger asking for the most sensitive number a person has — trust collapses on the spot. Pitch services before you have diagnosed the problem and everything you say sounds generic, because it is: you are describing a solution to a case you have not seen. The live coach enforces this the same way you should think about it — a fee only belongs after representation has been framed, and personal information only belongs after a fee has been quoted. Those are gates, not suggestions."
      },
      {
        kind: "prose",
        heading: "Objections arrive in order too",
        text: "A healthy call gets its objections in a predictable sequence. Early, they are trust objections — “who are you,” “how did you get my number,” “is this a scam.” In the middle, they are capability objections — “do you really understand my situation,” “I already have a CPA.” Money objections come last, and only after the prospect knows exactly what they are buying. If you are hearing price pushback in the first two minutes, that is not a price objection — it is a symptom that you skipped the sections that build value. Answer it briefly, then go back and do the work you skipped. See [[obj.early-price-probe]]."
      },
      {
        kind: "moves",
        heading: "How to think in beats",
        items: [
          "Each section is a short checklist of beats — the intro has three (identify yourself, name the firm, confirm the prospect), discovery has five facts, the pitch has four beats, the payment section has four. Know your current section’s beats and which ones are still open.",
          "A beat is done when it happened out loud, not when you meant to do it. “I sort of covered the forms” is an unchecked beat.",
          "Do not advance while a core beat is open. Discovery in particular: do not move to expert guidance until you have at least the balance, the unfiled years, and the collection status.",
          "If the call jumps ahead on its own — the prospect demands a price in minute two — answer what you must, then walk back and close the open beats. The arc is resumable.",
          "Between calls, review which beat you most often skip. That skipped beat is usually where your objections are coming from."
        ]
      },
      {
        kind: "compliance",
        text: "The method sells representation — never an outcome. At no point in the arc do we promise a settlement, an Offer in Compromise, a dollar reduction, or a date. We teach what WE do: file the authorizations, pull the record, review it with licensed staff, and request holds where appropriate. What the IRS will give is not ours to promise. And a do-not-call or “stop” request is terminal — it ends the pursuit, full stop, no matter which section you were in."
      }
    ],
    links: [
      "script.intro",
      "script.discovery",
      "script.expert",
      "script.pitch",
      "script.payment",
      "script.info",
      "script.close",
      "obj.early-price-probe",
      "obj.need-to-think",
      "strat.next-phase-control",
      "strat.objection-vs-condition",
      "psych.sandler.upfront-contract"
    ]
  },
  {
    id: "script.intro",
    part: "script",
    section: "method",
    title: "Introduction — the first thirty seconds",
    aliases: ["opener", "opening", "greeting", "inbound opener", "outbound opener", "gate", "permission bridge"],
    lead: "The introduction has one job: get a stranger to agree to keep talking. Identify yourself, name the firm, confirm you have the right person, explain why you are calling, and ask permission to continue — in roughly that order, in roughly thirty seconds.",
    blocks: [
      {
        kind: "prose",
        heading: "Phase 1 is a two-way legitimacy screen",
        text: "The opening does not only prove that we are legitimate; it determines whether the person on the other end intends to have a legitimate conversation. Basic identification is always available: your first name, the firm name, the truthful reason for the call, the public website or main line, and the fact that we are not the IRS. Everything beyond those public basics is progressive disclosure. Before giving detailed company information, internal details, or case-specific tax guidance, look for reciprocity: do they answer reasonable questions about themselves, describe a real tax problem we can help with, respond without staying permanently defensive, and allow the conversation to become an interview instead of a one-way examination of the firm? Caution is not hostility. A privacy-conscious prospect may need time or may prefer to call the public number back. Give them that path. But a person who only fishes for details while refusing every ordinary question has not earned deeper disclosure or advice. The full read — and the caller who is fishing — is covered in [[read.legitimacy]] and [[read.bad-actor]]."
      },
      {
        kind: "moves",
        heading: "The four legitimacy signals",
        items: [
          "Reciprocity — they provide ordinary information about their situation when asked, rather than demanding an unlimited one-way disclosure.",
          "A valid problem — they can describe a federal or state tax issue that is plausibly within our scope.",
          "Receptiveness — they answer reasonable qualifying questions without remaining defensive throughout the exchange.",
          "Interview posture — they are open to being interviewed about the case, not solely collecting company facts, tax tactics, or free advice."
        ]
      },
      {
        kind: "prose",
        heading: "Why the first thirty seconds decide the call",
        text: "On an outbound call, the prospect’s first instinct is defense: unknown number, unknown voice, and a topic — tax debt — they may be actively avoiding. Everything in the intro is aimed at lowering that defense before it hardens. You do that with three things said early and plainly: who you are, what firm you are with, and why this call exists. A prospect who still does not know what firm they are talking to sixty seconds in is a prospect deciding how to hang up. On inbound the dynamic is easier — they called you — but the beats are the same: identity, firm, and a warm invitation to talk. Whatever you do, do not open with scripted-sounding boilerplate like “this is a recorded line” before you have even said your name. Sound like a person first."
      },
      {
        kind: "moves",
        heading: "The beats, in order",
        items: [
          "Identify yourself — your first name, said like you would say it to a neighbor.",
          "Name the firm — clearly and early, not buried mid-sentence.",
          "Confirm the prospect — “Is this [name]?” — so you are not pitching a spouse or a voicemail.",
          "Say why you are calling — anchored to their online inquiry, honestly stated.",
          "Bridge to permission — ask a small question they can say yes to (“Sound fair?” / “Do you have a minute?”) before you ask anything else of them."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "Inbound: “Thank you for calling The Tax Group, this is [name]. How can I help you today?”",
          "Outbound: “You reached out through an online inquiry about tax help — I’m following up to confirm whether you’ve still got an active matter that needs representation. Sound fair?”",
          "Who we are: “We’re a licensed firm with enrolled agents, tax preparers, and other tax specialists. Our goal is to represent you with the IRS or state so you’re not left guessing about your records.”",
          "If they ask “are you the IRS?”: “We’re not the IRS. We’re a team of licensed tax professionals — our job is to represent people with the IRS, not collect for them.”",
          "If they lead with “how did you get my number?”: “It came through your online inquiry about tax help — a form you filled out about a tax balance. That’s the only reason I’m calling.”",
          "If they’re busy: “No problem — I’ll be brief. This will take about sixty seconds just to see if it’s even relevant to you. Fair enough?”"
        ]
      },
      {
        kind: "prose",
        heading: "The permission bridge",
        text: "The bridge is the small agreement that turns a cold interruption into a conversation. “Sound fair?” and “Do you have a minute?” are not filler — they hand the prospect a moment of control, and a prospect who says even a grudging “fine, what?” has agreed to keep talking. If the lead came from a form, anchor to it: name the source and the rough timing — “you filled out the tax-help form on our site a few days ago.” A prospect who remembers opting in is a completely different call from one who thinks you appeared from nowhere. Clear the gate before you ask a single discovery question; interrogating someone for personal details before they have agreed to talk is the fastest way to a hang-up."
      },
      {
        kind: "example",
        weak: "“Hi, this is a recorded line, I’m calling about your tax debt situation, can you verify your date of birth for me?”",
        strong: "“Hi, this is Marcus with The Tax Group. Is this David? … Great — you sent in an online inquiry about tax help a little while back, and I wanted to confirm whether you’ve still got an active matter that needs representation. Sound fair?”",
        note: "The weak open leads with compliance boilerplate, never names a human or a firm, and asks for PII before earning anything. The strong open is name, firm, confirmation, honest reason, and a permission bridge — in four breaths."
      },
      {
        kind: "drill",
        prompt: "Ten seconds into your outbound opener the prospect cuts in: “Just tell me what you want.” What’s your move?",
        answer: "Take the invitation — compress, don’t defend. “Fair enough. I’m [name] with The Tax Group, we’re a licensed firm with enrolled agents, tax preparers, and other tax specialists. You sent in an online inquiry about tax help and I’m calling to see if you’ve still got an open matter with the IRS or the state. Sixty seconds to find out if this is even relevant to you — fair?” You just cleared the whole gate in one answer and re-asked for permission."
      },
      {
        kind: "compliance",
        text: "If the prospect says “take me off your list,” “stop calling,” or anything that means do-not-call, that is terminal. Acknowledge it, confirm it will be honored, and end the call — no last pitch, no “before you go.” There is no save to attempt on a revocation."
      },
      {
        kind: "compliance",
        text: "Progressive disclosure never permits deception or evasiveness. Give basic public identity and compliance information accurately, and never invent a location, credential, result, or tax answer. Detailed company information and individualized tax guidance come only after reciprocal good-faith engagement and enough facts to answer responsibly. If legitimacy remains doubtful, offer the public website/main line for independent verification and end the exchange cleanly rather than arguing or improvising."
      }
    ],
    links: [
      "read.legitimacy",
      "read.bad-actor",
      "script.discovery",
      "obj.how-got-number",
      "obj.scam-distrust",
      "obj.busy-bad-time",
      "obj.not-interested",
      "obj.who-are-you",
      "obj.are-you-irs",
      "obj.dont-remember-signup",
      "obj.dnc-revocation",
      "strat.permission-legitimacy",
      "strat.anchor-to-inquiry",
      "strat.tone",
      "psych.voss.voice",
      "psych.sandler.upfront-contract"
    ]
  },
  {
    id: "script.discovery",
    part: "script",
    section: "method",
    title: "Case building — the five facts",
    aliases: ["discovery", "case building", "fact finding", "qualifying questions", "pain points"],
    lead: "Discovery is where you earn the rest of the call. Capture five facts — balance owed, unfiled years, collection status, income type, and ability to pay — and tie each problem back to the prospect’s real life, so the case stops being paperwork and starts being personal.",
    blocks: [
      {
        kind: "prose",
        heading: "Why discovery comes before everything",
        text: "You cannot pitch what you have not diagnosed. Every section after this one — the expert framing, the representation pitch, the fee — draws its power from the facts you gather here. An agent who skips discovery ends up generic-pitching: “we negotiate with the IRS” means nothing to anyone. An agent who did discovery well can say “you’ve got three unfiled years and a CP504 on the table — here is exactly what that means,” and the prospect feels understood before a single service has been named. Ask permission first — “To see if representation makes sense, can I ask a few quick questions?” — because a permissioned question is a conversation and an unpermissioned one is an interrogation."
      },
      {
        kind: "moves",
        heading: "The five facts to capture",
        items: [
          "Balance owed — how much, and is it federal, state, or both? Has it been growing?",
          "Unfiled years — any years not filed? Roughly how many? Any letters about missing returns?",
          "Collection status — letters, liens, garnishments, levies? When did the IRS or state last make contact?",
          "Income type — W-2, self-employed, 1099, retired? This shapes both the case and the conversation.",
          "Ability to pay — their financial picture at a high level: work situation, major expenses, whether professional help is realistic.",
          "As each issue surfaces, tie it to their life before moving to the next question — then bridge out when the picture is complete."
        ]
      },
      {
        kind: "prose",
        heading: "Pain-point tying — the part most agents skip",
        text: "The facts alone are a form. What makes discovery sell is tying each fact back to the prospect’s day-to-day life and bottom line: what they have already tried, how that went, what the letters feel like when they show up. When someone mentions a garnishment, do not just log it — ask what it has done to their paycheck. When they mention unfiled years, ask what has kept them from filing. You are doing two things at once: making the tax problem feel like a real, personal part of their life rather than an abstraction, and positioning yourself as the person who is here to help with exactly that. If they do not know a number, that is fine — and it is an opening: “That’s exactly what we find out. Once we’re authorized, we pull your IRS transcripts directly and get the full picture — what’s owed, from when, and how it’s grown.” We don’t guess; we build the case from the actual record."
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "Permission: “To see if representation makes sense, can I ask a few quick questions?”",
          "Balance: “Do you know roughly how much you owe the IRS or the state right now? Is that just federal, or state as well?”",
          "Unfiled: “Are there any years you haven’t filed yet? Roughly how many?”",
          "Collections: “Have you gotten letters about collections, a lien, or a garnishment? When’s the last time they contacted you?”",
          "History: “Have you worked with anyone on this before, or is this the first time you’re dealing with it?”",
          "When they don’t know the balance: “No problem — that’s exactly what we find out. We pull your IRS transcripts directly once we’re authorized, and that gives us the full picture.”",
          "The bridge out: “That gives me a clear picture. Let me explain what we typically see in cases like yours.”"
        ]
      },
      {
        kind: "example",
        weak: "“Okay so how much do you owe? Uh-huh. Any unfiled years? Okay. Any letters? Got it. So here’s what we charge—”",
        strong: "“About $40k, mostly federal — okay. And when those letters come in, what’s that been like? … Right, and that’s the thing: you’re making decisions about a balance you can’t even fully see. Have you filed every year, or are some still open? … That gives me a clear picture. Let me explain what we typically see in cases like yours.”",
        note: "The weak version is a checklist read at the prospect — facts collected, nothing built, then a jarring jump to price. The strong version gathers the same facts but reflects each one back, ties it to the prospect’s life, and exits over the bridge line so the expert section arrives naturally."
      },
      {
        kind: "drill",
        prompt: "Two questions into discovery the prospect says: “Look, just tell me what this costs.” What’s your move?",
        answer: "Don’t quote — a number now has nothing to anchor against. Acknowledge and trade: “Totally fair question, and I’ll give you exact numbers in a couple of minutes. The fee depends on what your case actually needs, so let me ask two more quick things so I don’t quote you for work you don’t need — fair?” Then finish the core facts. See [[obj.early-price-probe]]."
      },
      {
        kind: "compliance",
        text: "Discovery follow-ups must describe what we DO, not what the prospect will get. “Once we’re authorized we pull the transcripts and see exactly what’s on record” is right. “We can probably reduce that” or “we can stop that garnishment, sometimes same-day” is a promise about an IRS outcome and does not belong in your mouth."
      }
    ],
    links: [
      "script.expert",
      "obj.early-price-probe",
      "obj.dont-owe",
      "obj.working-with-irs",
      "obj.already-have-cpa",
      "obj.burned-before",
      "tax.collections-ladder",
      "tax.unfiled-sfr",
      "strat.pain-funnel",
      "strat.mirror-to-open",
      "psych.spin",
      "psych.sandler.pain-funnel",
      "psych.voss.calibrated-questions"
    ]
  },
  {
    id: "script.expert",
    part: "script",
    section: "method",
    title: "Expert guidance — the three factors",
    aliases: ["three factors", "expert framing", "owed filed on-record", "show knowledge", "stop guessing"],
    lead: "This is where you convert facts into authority. Frame every case around three factors — what’s owed, what’s filed, and what the IRS has on record — tie that frame to their specific situation with real nuance, and land the stop-guessing bridge.",
    blocks: [
      {
        kind: "prose",
        heading: "Why this section exists",
        text: "Between discovery and the pitch there is a moment most agents rush: the moment where you prove you actually understood what you just heard. The expert section is that proof. Its engine is the three-factors frame — simple enough for anyone to hold, true enough to organize every case. Every tax matter comes down to what’s owed, what’s filed, and what the IRS has already done on record — and the punchline is that until someone represents the prospect, the IRS makes it hard to see the full details of all three. That last part matters most: it plants, honestly, the reason representation is the next step, before you have pitched anything."
      },
      {
        kind: "moves",
        heading: "The beats",
        items: [
          "State the three factors — owed, filed, on-record — as the way every case works, not as a slogan.",
          "Tie the frame to THEIR case, using the discovery facts by name: their garnishment, their unfiled years, their notice.",
          "Add real nuance for whichever situation applies — this is where you sound like a professional instead of a script.",
          "Land the pain-relief bridge: stop guessing, start working with facts.",
          "Do not linger — once the bridge lands, move to the representation pitch while the frame is fresh."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "The frame: “Every tax case comes down to three things — what’s owed, what’s filed, and what the IRS has already done on record. Until someone represents you, the IRS makes it hard to see the full details.”",
          "Garnishment or levy: “That means the IRS has flagged the account for enforced collection. Overcoming an active levy is difficult — I won’t pretend otherwise — but once you’re represented, the attorney’s staff reviews the record and every adjustment that may be available, immediately and transparently.”",
          "Lien: “A lien doesn’t seize anything immediately — it secures the IRS’s claim so they get paid first if you sell or liquidate. Once the file is open we verify its accuracy and what it actually affects.”",
          "Unfiled returns: “When years go unfiled, the IRS files substitutes for you — and those almost always inflate the balance. Representation lets us pull your wage and income reports and get you filed correctly.”",
          "Business or payroll tax: “Payroll cases blend business and personal liability. Representation is how we separate what’s actually yours.”",
          "Self-employment or property sales: “Those trigger IRS mismatch notices. Once we can see the record, we find out if it’s audit-related, a reporting gap, or straight unpaid tax.”",
          "The bridge: “The goal is to stop guessing and start working with facts. Once you know exactly what’s on record, you can make calm, informed decisions.”"
        ]
      },
      {
        kind: "example",
        weak: "“Yeah, we deal with this stuff all the time. We negotiate with the IRS, we know all the programs, we can definitely help you out here.”",
        strong: "“Here’s how this actually works. Every case comes down to three things — what’s owed, what’s filed, and what the IRS already has on record. In your case: you told me about $40k owed, two years unfiled — which means the IRS has likely filed substitutes for those years, and substitutes almost always inflate the balance — and a CP504, which is them signaling enforced collection. Until someone represents you, you can’t fully see any of the three. The goal is to stop guessing and start working with facts.”",
        note: "The weak version claims expertise; the strong version demonstrates it — same frame, but loaded with the prospect’s own facts and one piece of nuance (substitute returns inflate balances) they probably didn’t know. Specificity is what authority sounds like."
      },
      {
        kind: "drill",
        prompt: "The prospect says: “I got a letter saying they put a lien on me. Does that mean they’re taking my house?” What’s your move?",
        answer: "Calm, precise, no drama: “Good question — a lien doesn’t seize anything immediately. It secures the IRS’s claim, so they get paid first if you ever sell or liquidate. What we do once the file is open is verify it’s even accurate and see exactly what it touches. That’s the difference between guessing and knowing.” You corrected a fear with a fact, and the correction itself made the case for representation."
      },
      {
        kind: "compliance",
        text: "Nuance is not a license to promise. “Overcoming an active levy is difficult, and we review every option immediately” is honest expertise. “We can get that levy released” is a promised outcome. Show knowledge about how the system works — never about what the IRS will decide."
      }
    ],
    links: [
      "script.pitch",
      "tax.levy-garnishment",
      "tax.lien",
      "tax.unfiled-sfr",
      "tax.payroll-941-tfrp",
      "tax.collections-ladder",
      "obj.will-it-make-worse",
      "obj.dont-owe",
      "strat.expert-specificity",
      "strat.calm-urgency",
      "strat.channel-relief",
      "psych.cialdini.authority"
    ]
  },
  {
    id: "script.pitch",
    part: "script",
    section: "method",
    title: "The representation pitch",
    aliases: ["representation", "POA pitch", "2848", "8821", "power of attorney", "foundation not fix", "marathon"],
    lead: "The pitch is representation-first: three authorizations — IRS Form 2848, Form 8821, and the state POA — presented as the foundation of everything, not a fix. Set the marathon expectation, add honest urgency, and differentiate by refusing to make big promises.",
    blocks: [
      {
        kind: "prose",
        heading: "Representation is the product",
        text: "We do not sell settlements, we do not sell dollar reductions, and we do not sell dates. We sell representation — the legal standing that lets licensed professionals see the prospect’s actual record and speak to the IRS on their behalf. Everything in this section flows from that. The first step in resolving any tax matter is getting formally represented with the IRS and any state agencies, and that takes three authorizations: Form 2848, Form 8821, and the state POA where it applies. Explain each one plainly, without jargon: the 2848 is a limited power of attorney — it lets the attorney’s staff speak directly with the IRS and receive case information. The 8821 is a tax information authorization — it lets us pull the master file and transcripts and review every balance, filing, and notice. The state POA does the same at the state level. A prospect who understands what each form does stops seeing paperwork and starts seeing access."
      },
      {
        kind: "moves",
        heading: "The beats",
        items: [
          "Frame representation as the first step — before strategy, before options, before anything.",
          "Name and explain the three authorizations: 2848, 8821, state POA — each in one plain sentence.",
          "Foundation, not a fix: the forms don’t change the balance; they open the door to the facts.",
          "Set the expectation: marathon, not a sprint — each step has to be accurate for the next one to mean anything.",
          "Add honest urgency where it exists: if there has been active IRS communication, the sooner representation is filed, the sooner the legal team engages.",
          "Differentiate calmly: no big promises — that is the point, not an apology."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "The pitch: “The first step toward resolving any tax matter is getting you formally represented with the IRS and any state agencies. That involves three authorizations: IRS Form 2848, Form 8821, and the state POA if applicable.”",
          "Foundation, not fix: “These forms don’t change your balance — they open the door so we can see the facts and communicate lawfully. Once they’re filed, we run a full compliance check and follow up with guidance as your record comes back.”",
          "Expectation: “Tax-debt work is a marathon, not a sprint — each step has to be accurate so the next one means something. Representation is the starting line; until we’re inside your file, it’s premature to comment on strategy.”",
          "Honest urgency: “But if you’ve had active IRS communication, time matters — we can’t control how long the IRS takes, which is exactly why we need to get you protected today by filing the power of attorney. Nothing moves forward without it.”",
          "Differentiation: “A lot of companies rush to big promises. We don’t. We take the responsible path — get you represented, gather verified data, then outline real options based on facts.”"
        ]
      },
      {
        kind: "prose",
        heading: "The no-promises differentiator",
        text: "“We don’t make big promises” sounds like a weakness until you say it with conviction — then it becomes the strongest thing in the pitch. Half your prospects have already heard a radio ad promising pennies on the dollar, and a good fraction have been burned by a firm that talked big and delivered little. Refusing to guess before you have seen the record is what a real professional does, and prospects know it. If they push for a prediction — “so what will I end up paying?” — hold the line: it is premature to comment on strategy until we are inside the file, and anyone who answers that question without seeing the transcripts is making it up. That answer builds more trust than any number would. If they already have a CPA, note the honest distinction: preparing returns and representing someone in collections are different jobs — see [[tax.representation]]."
      },
      {
        kind: "example",
        weak: "“Honestly, with your numbers you’d probably qualify for an Offer in Compromise — we could likely settle this for way less. We just need to get the POA signed to get started on that.”",
        strong: "“Here’s what I won’t do — I won’t promise you a number, because anyone who does that before seeing your transcripts is guessing. What I can tell you is exactly what happens next: we file the 2848 and 8821, we pull your full IRS record, licensed staff review every balance and notice, and then we outline your real options based on facts. A lot of companies rush to big promises. We take the responsible path.”",
        note: "The weak version promises an outcome to win the signature — it is a compliance violation and it sets up a client who feels lied to in month three. The strong version sells the refusal to promise as the very reason to hire us. Trainer rule: any guarantee is an ethical flag even if the close happens."
      },
      {
        kind: "drill",
        prompt: "The prospect says: “The other company I talked to said they could settle it for 10% — can you beat that?” What’s your move?",
        answer: "Differentiate without bashing: “I can’t promise you a settlement number, and truthfully, neither can they — nobody knows what your case supports until they’re inside your IRS file. What I can promise is what we do: representation filed, transcripts pulled, licensed review, and real options laid out from facts. If a promise made before anyone has seen your record sounds off to you — that instinct is right.”"
      },
      {
        kind: "compliance",
        text: "This section is the compliance spine’s home ground. Never promise a result, an OIC, a percentage, a dollar figure, or a timeline for an IRS outcome. Urgency must be real (active IRS communication, enforced-collection posture) — never manufactured (“today only” is an ethical flag, full stop). Differentiate without bashing competitors by name or claim."
      }
    ],
    links: [
      "script.payment",
      "tax.representation",
      "tax.resolution-options",
      "obj.already-have-cpa",
      "obj.diy-self-rep",
      "obj.oic-myself",
      "obj.guarantee-seeking",
      "obj.how-long",
      "obj.burned-before",
      "obj.success-rate",
      "strat.confident-value-frame",
      "strat.calm-urgency",
      "strat.earn-trust-with-proof",
      "psych.cialdini.authority",
      "psych.cialdini.commitment"
    ]
  },
  {
    id: "script.payment",
    part: "script",
    section: "method",
    title: "The fee and the payment ladder",
    aliases: ["the close", "fee", "payment terms", "payment ladder", "flat fee", "anchor full", "$350", "card on file"],
    lead: "State the flat fee matter-of-factly, then stop talking. If they hesitate, walk the ladder one rung at a time — paid in full first, then the two-payment split, then four monthly at $350 minimum, then card on file — and close with a choice between options, never a yes/no.",
    blocks: [
      {
        kind: "prose",
        heading: "Building the quote — scope and capacity first",
        text: "The number you state is built, not recited. Two inputs decide it: the scope of work — how many returns need preparing, how many agencies need representation, what the collection posture looks like — and the prospect’s realistic ability to pay, which discovery already gave you. The floor’s general rules of thumb: about $350 per tax return that needs preparing, and at least $1,200 for representation per institution — IRS or state. Treat those as starting points for judgment, not a menu to read aloud. And when the case is unusual or the right number isn’t obvious, use the play that costs nothing: put them on a brief hold and confer with the team about the best quote. “Give me one moment — I want to make sure I quote you exactly right” sounds like diligence because it is. Never invent a number under pressure; a short hold beats a guessed quote every time."
      },
      {
        kind: "prose",
        heading: "State the fee, then pause",
        text: "The fee line is one sentence, delivered like a fact: the flat legal fee for representation, what it covers, done. Then the hardest move in the section: silence. Do not justify, do not soften, do not fill the gap — let them react. Most agents lose the close in the three seconds after the number, talking it down before the prospect has even objected. If they agree, you are done here; move straight to [[script.info]]. If they hesitate — “that’s a bit high,” “I can’t do that all at once” — don’t hear a rejection yet: most of the time that is your cue to walk the ladder. And note what the hesitation is actually about: a prospect who asks “what am I paying for?” didn’t hear the value; go back and re-anchor scope before offering structure. Itemize what is included — the POA forms, transcript retrieval, the compliance review by the attorney’s staff — before the number, not as a rescue after it."
      },
      {
        kind: "moves",
        heading: "The ladder, one rung at a time",
        items: [
          "State the flat fee, matter-of-fact, with what it covers. Then PAUSE.",
          "Anchor paid-in-full FIRST — always start from full, never lead with the easiest terms.",
          "Rung two — two-payment split: half today to open the case, the balance in 30 days. The first payment secures the case position and still gets the POA filed right away.",
          "Rung three — four monthly payments, minimum $350 per month, to keep the file moving and in good standing.",
          "Rung four — card on file: state the balance, then move straight to “how will you be paying?” Keep it casual and standard — it is standard under the attorney-client service agreement.",
          "Final close — alternative choice, never yes/no: full today, two payments, or four monthly — which works best?",
          "Only reveal one rung at a time. Make them break it down level by level — never dump the whole menu at once."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "The fee: “The flat legal fee for representation is $___. That covers preparing and filing the federal and state POA forms, transcript retrieval, and your initial compliance review by the attorney’s staff.” (Then silence.)",
          "Anchor full: “Most clients take care of this all at once so their file moves immediately — once payment and signed docs are in, the POA is filed and representation is activated the same day.”",
          "Two-payment: “Half today to open the case, the balance in 30 days — that still gets your POA filed right away.”",
          "Four-month: “Four monthly payments, minimum $350 a month, to keep the file moving and in good standing.”",
          "The close: “So the total fee is $___. You can take care of it in full today, or start with two payments, or four monthly of $350 — which works best to get representation started today?”"
        ]
      },
      {
        kind: "prose",
        heading: "Structure, not discount",
        text: "The ladder never lowers the fee — it restructures it. That distinction is the whole tone of the section. Frame each rung as making the same fee manageable, never as making it cheaper, and never drop the price itself: a price that moves without a reason tells the prospect the original number was inflated, and the trainer scores exactly that as a fail signal. Confidence first, options second. Never apologize for the fee — it is linked to professional value and immediate action, and an agent who sounds sorry about the number teaches the prospect to be sorry too. If they go quiet after the number, let them. Silence after a number is your ally, not a problem to fix — see [[strat.silence-after-number]]. If “I need to think it over” surfaces here, that has its own play: acknowledge, summarize the value, offer the website and reviews only now, and keep the door open — see [[obj.need-to-think]]."
      },
      {
        kind: "example",
        weak: "“So the fee is $___… I know that’s a lot, I’m really sorry — but we might be able to do a discount? Would that work for you?”",
        strong: "“The flat legal fee for representation is $___. That covers the federal and state POA forms, transcript retrieval, and your compliance review by the attorney’s staff. … (silence) … Most clients take care of it all at once so the file moves immediately — the day payment and signed docs are in, your POA is filed. If it’s easier to structure, we can do half today and the balance in 30 days. Which works best to get representation started today?”",
        note: "The weak version apologizes, then cuts the price unprompted — the prospect now believes the number was padded, and the trainer flags exactly this (“agent dropped price without a reason”). The strong version states, pauses, anchors full, offers structure only in response to hesitation, and exits on an alternative-choice close."
      },
      {
        kind: "drill",
        prompt: "You quote the fee. Five seconds of dead air, then: “Yeah… I just can’t do that all at once.” What’s your move?",
        answer: "That is not a no — it is a request for structure, and it tells you paid-in-full is off the table but the sale is alive. Next rung, framed as structure: “Completely understandable — that’s why there are options. Half today to open the case and the balance in 30 days, and your POA still gets filed right away. Or if monthly works better, four payments at $350 minimum keeps the file moving. Which of those works best?” Note you never touched the total."
      },
      {
        kind: "compliance",
        text: "Never apologize for the fee and never discount it — restructure it. Payment terms are structure (“to make it manageable”), never a markdown. No fake urgency to force the close: “today only” pricing is an ethical flag. The fee buys representation and defined work — the POA filings, transcripts, compliance review — never a promised outcome. And if the answer is a firm no, it is a no: pressure tactics on a hesitant prospect are a flag even when they work."
      }
    ],
    links: [
      "script.info",
      "obj.cant-afford",
      "obj.price-too-high",
      "obj.need-to-think",
      "obj.spouse-consult",
      "obj.contingency",
      "obj.guarantee-seeking",
      "strat.silence-after-number",
      "strat.alternative-choice",
      "strat.confident-value-frame",
      "strat.reduction",
      "strat.isolate",
      "strat.buying-signals",
      "psych.cialdini.commitment"
    ]
  },
  {
    id: "script.info",
    part: "script",
    section: "method",
    title: "Information collection — the trust choreography",
    aliases: ["info collection", "SSN", "personal information", "DOB", "start the file", "DocuSign", "Circular 230"],
    lead: "Once the fee has landed, collect the file: full legal name, contact details, date of birth, SSN at signing, and the payment method. The facts are easy — the craft is the choreography of asking, because you are requesting the most sensitive numbers a person has.",
    blocks: [
      {
        kind: "prose",
        heading: "Why this section has its own craft",
        text: "By the time you are here, the prospect has agreed to the fee — but agreement is not the same as comfort. You are about to ask a person who was worried about scams twenty minutes ago for their Social Security number and a card. The choreography matters more than the checklist. Open with purpose, not extraction: “Let’s get your file started so we can prepare your authorization and agreement” frames every question that follows as building THEIR case, not filling YOUR form. Sequence from easy to sensitive — name, address, email and phone, date of birth — and take the SSN at signing, tied directly to the forms it enables, not floated mid-call as a naked ask. Every piece of information should arrive with its reason attached."
      },
      {
        kind: "moves",
        heading: "The beats, easy to sensitive",
        items: [
          "Open the file with purpose: “Let’s get your file started so we can prepare your authorization and agreement.”",
          "Full legal name — exactly as it appears on their returns.",
          "Contact: address, email, phone — confirm spelling; a bounced email stalls the whole file.",
          "Date of birth.",
          "SSN — at signing, tied to the 2848/8821 it makes possible, with the security reassurance ready.",
          "Payment method — asked plainly, as the standard step it is.",
          "Reassure on security once, clearly — then keep moving. Over-reassuring reads as nervous."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "Opening the file: “Let’s get your file started so we can prepare your authorization and agreement.”",
          "The security reassurance: “Everything stays secure under federal privacy rules and IRS Circular 230. You’ll review and sign everything — via DocuSign — before anything is filed.”",
          "The SSN, with its reason: “Can I get your Social Security number so we can complete the Power of Attorney? This is what lets us pull your full IRS file and speak to them directly on your behalf — without it, we can’t legally access or represent your case.”",
          "If they hesitate on the SSN: “I completely understand. This is required for us to legally represent you with the IRS — we’re a licensed firm, your information is secure, and nothing gets filed until you’ve reviewed and signed.”",
          "Payment method: “And how will you be paying today — debit or credit?”"
        ]
      },
      {
        kind: "prose",
        heading: "When they freeze",
        text: "A hesitation here is usually not about the data — most of the time it is the last flare of the scam fear. Read which one you are facing before you answer. Pushing is the one move that reliably backfires; the strongest play is almost always to hand them control. Invite verification: have them write down the firm name and look it up while you are on the line, and remind them that nothing is filed until they have reviewed and signed the DocuSign themselves. A prospect who was on the verge of guarding their information will flip to participating the moment you make verification their idea. The review-before-filing point is your strongest card: they are not surrendering anything on this call — they are preparing documents that they will read and sign before a single form goes anywhere."
      },
      {
        kind: "example",
        weak: "“Okay and I’ll need your social security number. … Hello? Ma’am, I need your SSN to proceed.”",
        strong: "“Before I ask for anything sensitive — write down our firm name, look us up while I’m on the line, and only share what you’re comfortable with after that. Sound fair? … The reason I need your Social is the Power of Attorney: it’s what lets us pull your IRS file and speak to them on your behalf. And nothing is filed until you’ve reviewed and signed everything yourself, through DocuSign.”",
        note: "The weak version makes the ask naked and then repeats it harder — the prospect is now deciding whether to give a fake number. The strong version pre-empts the fear, hands over control, attaches the reason to the ask, and closes the loop with review-before-filing. Defensive becomes participating."
      },
      {
        kind: "drill",
        prompt: "The prospect stops you: “I’m not giving my social to someone who called me out of the blue.” What’s your move?",
        answer: "Agree with the instinct, then hand them the wheel: “Honestly? Good — you shouldn’t give it to just anyone who calls. Here’s what I’d suggest: write down our firm name, pull up our site and our reviews right now while I’m on the line. And keep in mind, nothing gets filed until you’ve read and signed the documents yourself. When you’re comfortable, we’ll finish the file — no sooner.” You validated the defense instead of fighting it."
      },
      {
        kind: "compliance",
        text: "The order is not optional: personal information is collected only after a fee has been quoted and agreed. Collecting PII from a prospect who has not committed is the trainer’s definition of an unjustified close. The reassurances must be true and specific — federal privacy rules, IRS Circular 230, review-and-sign via DocuSign before anything is filed — never vague soothing."
      }
    ],
    links: [
      "script.close",
      "script.payment",
      "obj.scam-distrust",
      "obj.how-can-i-trust",
      "obj.company-name-verify",
      "obj.spouse-consult",
      "tax.representation",
      "strat.earn-trust-with-proof",
      "strat.permission-legitimacy",
      "strat.take-the-yes",
      "psych.voss.accusation-audit",
      "psych.cialdini.commitment"
    ]
  },
  {
    id: "script.close",
    part: "script",
    section: "method",
    title: "The close — summarize, reinforce, welcome",
    aliases: ["wrap up", "closing", "welcome call", "summary", "end of call"],
    lead: "The close is three beats: summarize exactly what happens next, reinforce why representation was the right call, and set the welcome call. It takes ninety seconds and it is what the client remembers when the receipt hits their inbox tonight.",
    blocks: [
      {
        kind: "prose",
        heading: "Why the last ninety seconds matter",
        text: "The sale is made, and the biggest risk left is the one you cannot see: buyer’s remorse at nine o’clock tonight, when the charge posts and the spouse asks what it was for. The close is your inoculation. A client who can repeat back what they bought — “they file my POA, pull my transcripts, and the attorney’s staff reviews everything” — has a story to tell themselves and their spouse. A client whose call just… ended after the card number has a charge and a doubt. Summarize the plan in plain words, remind them why it was smart, and give them a concrete next touch to hold onto. Do not oversell here, and do not keep pitching a sale you already made — a wrapped call should feel finished, warm, and certain."
      },
      {
        kind: "moves",
        heading: "The beats",
        items: [
          "Summarize the plan — what we file, what we pull, who reviews it, and what they get back. Specific, short, in their language.",
          "Reinforce the value — representation is the foundation; now they will know exactly where they stand.",
          "Set the welcome call — the concrete next touch: welcome call and confirmation email typically within one business day.",
          "End on respect for the decision — they got in front of this today; say so.",
          "Then stop talking. The worst close is the one that keeps going."
        ]
      },
      {
        kind: "lines",
        heading: "The real lines — adapt, don’t recite",
        items: [
          "Summarize: “We’ll file your limited Power of Attorney, request your IRS and state transcripts, and have the attorney’s staff review everything for accuracy. Then you get a complete summary and next steps.”",
          "Reinforce: “Representation is the foundation for anything that follows — knowing exactly where you stand, so your next decisions are informed.”",
          "The welcome: “Thank you for getting in front of this. You’ll receive your welcome call and confirmation email typically within one business day.”"
        ]
      },
      {
        kind: "drill",
        prompt: "Card collected, docs sent — and as you start wrapping up the client asks: “So how long until this is all resolved?” What’s your move?",
        answer: "Summarize what is scheduled instead of predicting what is not: “Here’s what I can put a clock on: your POA gets filed as soon as your signed docs are in, the transcript requests go out, and you’ll have your welcome call typically within one business day. Once the attorney’s staff has your actual record, they’ll walk you through the realistic timeline for your case — that way it’s based on your file, not a guess from me.” You gave certainty about our steps and honesty about theirs."
      },
      {
        kind: "compliance",
        text: "The summary restates what WE do — file the POA, request transcripts, licensed review, follow-up guidance — never what the IRS will decide or when. The only dates in the close are ours to keep: the welcome call and confirmation email typically within one business day. Promise the process, never the outcome."
      }
    ],
    links: [
      "script.method",
      "script.info",
      "obj.how-long",
      "tax.representation",
      "strat.commitment-language",
      "strat.take-the-yes",
      "psych.cialdini.commitment",
      "psych.voss.thats-right"
    ]
  }
];
