import type { ManualEntry } from "./types";

export const OBJECTION_TRUST_ENTRIES: ManualEntry[] = [
  // ── COMPLIANCE ──────────────────────────────────────────────────────────────
  {
    id: "obj.dnc-revocation",
    part: "objections",
    section: "compliance",
    title: "“Stop calling me — take me off your list”",
    aliases: [
      "stop calling",
      "don't call me",
      "do not call",
      "take me off",
      "off your list",
      "remove my number",
      "quit calling",
      "never call",
      "stop contacting me",
      "do not contact me",
    ],
    lead:
      "This is not an objection and there is no play. An explicit removal demand is a legal revocation under TCPA — you honor it, confirm it, and end the call. It is the one moment in this entire manual where the answer is never to overcome.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Every other entry in this part teaches you a way through. This one teaches you the single exception. “Take me off your list” is a do-not-call demand — a legal revocation, not a negotiating position. The prospect is not asking for a better pitch; they are exercising a right. The whole doctrine of this manual — every play advances, never retreat, the agent decides when to quit — stops at exactly this line. When the demand is explicit, the law decides, not you.",
      },
      {
        kind: "prose",
        heading: "The boundary that matters",
        text:
          "Learn to hear the difference between a removal demand and a brush-off, because they route to opposite plays. “Stop calling me,” “take me off your list,” “remove my number” — terminal, honor it. “Not interested,” “I’m good,” “no thanks” — a reflex, fully coachable; see [[obj.not-interested]]. If someone says “not interested” and you re-engage and they then demand removal, that second statement wins. Never push past it.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Confirm the removal explicitly and immediately — no value statement, no one-more-question, no pause.",
          "End warmly and briefly; a clean exit is the last impression the brand leaves.",
        ],
      },
      {
        kind: "lines",
        heading: "The line",
        items: [
          "Understood — I’m removing your number right now. You won’t hear from us again. Take care.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Continuing to pitch after they’ve said it — and never, ever after a second no.",
          "Arguing with their right to be removed, or bargaining (“but you don’t even know what we do yet”).",
          "Slipping in one more value statement or question on the way out. The confirmation goes out alone.",
          "Sounding wounded or curt. Graceful compliance is the only brand-protecting move left.",
        ],
      },
      {
        kind: "example",
        weak:
          "“But wait — you don’t even know what we do yet. Just give me thirty seconds and if you still want off the list, I’ll take you off.”",
        strong:
          "“Understood — I’m removing your number right now. You won’t hear from us again. Take care.”",
        note:
          "The weak version bargains with a legal demand — that’s a compliance violation and it confirms every scam fear they had. The strong version is immediate, explicit, and warm. Compliance IS the move, and doing it gracefully is the last impression you control.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I’m not interested — actually, you know what, just take me off your list.” — what’s your move?",
        answer:
          "The second sentence overrides the first. “Not interested” alone is coachable, but the moment “take me off your list” lands, this is a removal demand. Confirm it immediately — “Understood, I’m removing your number right now, you won’t hear from us again” — and end the call. No follow-up question, no value line.",
      },
      {
        kind: "compliance",
        text:
          "An explicit do-not-call demand is terminal under TCPA and state DNC law. Honor it immediately, confirm the removal out loud, and disengage — no re-engagement, no value statement, no question. Never sell past a second no on removal. This applies even when the deal was alive ten seconds earlier.",
      },
    ],
    links: ["obj.not-interested", "obj.how-got-number", "script.intro"],
  },

  // ── TRUST ───────────────────────────────────────────────────────────────────
  {
    id: "obj.not-interested",
    part: "objections",
    section: "trust",
    title: "“Not interested”",
    aliases: [
      "not interested",
      "no thanks",
      "no thank you",
      "i'm good",
      "we're all set",
      "not for me",
      "don't need it",
      "don't need any help",
    ],
    lead:
      "A reflex brush-off, not a verdict — they answered an unknown number mid-task and said the thing everyone says. It is fully coachable, with one bright line: the moment it becomes a removal demand, it stops being this objection and becomes [[obj.dnc-revocation]].",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "“Not interested” in the first thirty seconds is usually a reflex, not a verdict on your offer — they haven’t heard your offer yet. Trust your read: an autopilot brush-off sounds different from a considered no, and only the first one is yours to coach through. It’s a judgment about unknown callers, delivered on autopilot while they’re making dinner. They want out of a category (sales calls), not out of a solution to a problem that does not go away on its own. That distinction is your whole opening: you are not selling — you are returning THEIR inquiry.",
      },
      {
        kind: "prose",
        heading: "The boundary with DNC — keep it crisp",
        text:
          "“Not interested” is coachable. “Take me off your list” is law. If they demand removal — “stop calling,” “take me off,” “remove my number” — that is [[obj.dnc-revocation]]: honor it, never overcome it. And even within the coachable version, the rope is short: one graceful re-engagement, maybe two. If they say no again after your best question, you never push past a second no. The agent decides when to move on — but a second refusal after a removal-flavored no is not a decision point, it’s the exit.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Anchor to their inquiry immediately (source + their tax issue) — that’s what separates you from every robocall. See [[strat.anchor-to-inquiry]].",
          "One value sentence tied to consequence (notice deadlines, penalties compounding), then ONE question — a question keeps the conversation alive where a pitch ends it.",
          "Re-engage off their own facts: “not interested in fixing the balance, or not interested in sales calls? Those are different things.”",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Totally fair — quick context: you’d reached out about the tax balance, and the reason I’m calling now is those IRS letters have clocks on them. Did the last one mention a levy?",
          "I hear you. Before I let you go — was the back-tax issue handled, or is it still sitting there?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Apologizing for the call or offering to “give them space” — you never retreat, you offer the way through.",
          "Launching a pitch in response. A pitch ends the conversation; a question extends it.",
          "Continuing after they say it a second time with removal language — that’s the DNC line.",
          "Pressure tactics: “but wait, you don’t even know what we do yet.”",
        ],
      },
      {
        kind: "example",
        weak:
          "“Oh — okay, sorry to bother you. Are you sure? We really do great work. Well… if you change your mind, we’re here.”",
        strong:
          "“Totally fair — quick context: you’d reached out about the tax balance, and the reason I’m calling now is those IRS letters have clocks on them. Did the last one mention a levy?”",
        note:
          "The weak version apologizes, pitches into the no, and retreats — three losses in one breath. The strong version never apologizes, anchors to their own inquiry, ties one consequence to it, and ends on a question about their facts. Questions keep people talking; pitches make them hang up.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Yeah, no thanks, I’m good.” — what’s your move?",
        answer:
          "Anchor to their inquiry and ask one question off their facts: “Fair enough — you’d reached out about the back balance. Was that handled, or is it still sitting there?” No apology, no pitch. If they answer, you’re in discovery. If they escalate to “take me off your list,” switch instantly to the DNC play and confirm removal.",
      },
    ],
    links: [
      "obj.dnc-revocation",
      "strat.anchor-to-inquiry",
      "strat.objection-vs-condition",
      "script.intro",
    ],
  },
  {
    id: "obj.scam-distrust",
    part: "objections",
    section: "trust",
    title: "“Is this a scam?”",
    aliases: [
      "is this a scam",
      "sounds like a scam",
      "are you a robot",
      "don't trust tax companies",
      "you people are crooks",
      "heard bad things",
      "companies like yours",
      "rip people off",
      "too good to be true",
      "are you legit",
      "sounds like a scheme",
      "fraud",
    ],
    lead:
      "Skepticism here is rational — they’ve heard the radio ads and the horror stories. Agree with the premise, then separate yourself with verifiable specifics instead of reassurance. Scammers don’t say “take a minute, I’ll wait.”",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "They’ve absorbed years of “pennies on the dollar” ads and phone-scam warnings, and often there’s a prior bad experience or a fear of being burned while vulnerable underneath. In a scam-saturated environment, this question is what a sensible person asks — sometimes it’s also a deflection, but you treat it as legitimate either way. The critical insight: reassurance cannot answer it. “We’re totally legit, trust me” is exactly what a scammer says. Only verifiable specifics — things they can check themselves, right now — answer it.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Validate first: “you’re right to be careful” lands better than any defense. That’s an accusation audit — name their suspicion before they harden into it. See [[psych.voss.accusation-audit]].",
          "Offer public verification: spell the firm name, provide the approved public website and main line, and invite them to verify independently. Then ask one ordinary case question before offering any deeper company detail or tax guidance.",
          "Shift from promises to process: explain WHAT happens (POA, transcripts, compliance review) — concrete process talk is what scammers almost never bother to offer.",
          "Never promise outcomes or savings numbers — guarantee-talk confirms their fear. Refusing to guarantee IS the credibility move.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Honestly? You should be skeptical — there’s been garbage in this industry. Pull up our site right now while we talk; I’ll wait.",
          "I’m not going to promise you a settlement number — anyone who does on a first call is lying to you. What I can tell you is exactly what we’d do first.",
          "Fair question — I’d ask the same thing. Here’s our name spelled out, our public website, and our main line. Take a minute and verify us; then let me confirm whether there’s an actual tax issue we can help with.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Defensive denials — “Of COURSE not!” Defensiveness reads as guilt.",
          "Over-reassurance and excessive cheerfulness — it sounds scripted, which is exactly what they’re listening for.",
          "Vague social proof: “we’ve helped thousands of people” answers nothing they can verify.",
          "Any guarantee or savings number — it confirms the ad-scam pattern they’re afraid of.",
        ],
      },
      {
        kind: "example",
        weak:
          "“No, no, of course it’s not a scam! We’re a totally legitimate company, we’ve helped thousands of people just like you, I promise you can trust us.”",
        strong:
          "“Honestly? You should be skeptical — there’s been garbage in this industry. Pull up our site right now while we talk; I’ll wait. And I’m not going to promise you a settlement number — anyone who does on a first call is lying to you.”",
        note:
          "The weak version denies, reassures, and promises — the exact three-beat pattern of every scam call they’ve ever gotten. The strong version agrees with the skepticism, hands them something checkable, and refuses to guarantee. Confidence plus an invitation to verify will usually beat insistence on legitimacy.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “How do I know you’re not one of those tax-relief scams I keep hearing about?” — what’s your move?",
        answer:
          "Agree first — “you don’t yet, and you’re right to ask” — then provide the approved public verification: spell the firm name, give the public website and main line, and invite them to verify independently. Ask one ordinary question about the tax issue. If they reciprocate, explain the high-level process: “we begin by establishing authorization, reviewing the records, and determining compliance. No promises about numbers; anyone promising numbers on a first call is who you should hang up on.”",
      },
      {
        kind: "compliance",
        text:
          "Never promise a result, an OIC, a dollar figure, or a date to prove legitimacy — guarantee-talk is both a compliance violation and the fastest way to confirm their scam fear. Say what WE do (file representation, pull transcripts, request a hold), never what the IRS will give or when.",
      },
    ],
    links: [
      "strat.earn-trust-with-proof",
      "psych.voss.accusation-audit",
      "strat.agree-first",
      "obj.company-name-verify",
      "obj.guarantee-seeking",
      "script.intro",
    ],
  },
  {
    id: "obj.who-are-you",
    part: "objections",
    section: "trust",
    title: "“Who are you? Why are you bothering me?”",
    aliases: [
      "who are you",
      "why are you bothering me",
      "who is this",
      "why are you calling me",
      "stop sending me mail",
      "what do you want",
    ],
    lead:
      "You’re an intruder until proven otherwise — the hostility is the door’s lock, not a verdict on you. The answer is calm, complete identification and one sentence on why they’d want to keep listening. Never apologetic, never defensive.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Hostility this early isn’t about you — it’s about every robocall and scam attempt that came before you. Until you prove otherwise, you are one of them. The prospect is demanding two things at once: identification (who is this?) and justification (why should I still be on this phone?). Most agents fail by answering only one, or by answering both apologetically. Apology reads as guilt; defensiveness reads as evasion; skipping past the hostility to pitch reads as a script. Calm completeness is the only register that passes.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Acknowledge the heat calmly — don’t match it, don’t flinch from it. See [[strat.hostility-resilience]].",
          "Identify completely in one breath: your full name, the firm’s name, what the firm does, and how you got their information — their inquiry, or the public lien record, whichever is true.",
          "Give exactly one sentence on why they might want to keep listening — tied to THEIR situation, not your offer.",
          "Then stop and ask a question. Don’t pile on. The identification earns you one question; use it.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Fair question. I’m [name] with The Tax Group — we represent people who owe the IRS. You’d reached out about a back-tax balance, and that’s the only reason I’m calling. Is that still sitting there?",
          "I get it — you don’t know me from the last five robocalls. I’m [name] with The Tax Group, and the reason you specifically: the tax inquiry you sent in. Thirty seconds to tell you why it matters now?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Apologetic over-explaining — “I’m so sorry to bother you, I know these calls are annoying…” You never apologize for the call.",
          "Defensiveness or matching their tone — you lose the frame the moment you argue.",
          "Skipping past the hostility to pitch — they asked who you are; answer THAT first or nothing after it lands.",
          "Vague identification: “I’m calling from a tax company” confirms the robocall read.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Uh, sorry — I know these calls are annoying, I’m just calling from a tax services company, we help people with tax problems, anyway the reason for my call today is a great program that—”",
        strong:
          "“Fair question. I’m [name] with The Tax Group — we represent people who owe the IRS. You’d reached out about a back-tax balance, and that’s the only reason I’m calling. Is that still sitting there?”",
        note:
          "The weak version apologizes, identifies vaguely, and bulldozes into a pitch — three confirmations that this is exactly the call they thought it was. The strong version answers the actual question completely, gives one reason to stay, and ends on a question about their facts. Calm, complete, done.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect snaps: “Who IS this? Why do you people keep calling me?” — what’s your move?",
        answer:
          "Full identification, calmly, in one breath: name, firm, what the firm does, and the specific reason for the contact — their inquiry or the public record. Then one sentence of relevance and one question. No apology, no defense, no pitch. If the “stop calling” hardens into an explicit removal demand, that’s DNC — honor it.",
      },
    ],
    links: [
      "strat.hostility-resilience",
      "strat.permission-legitimacy",
      "obj.how-got-number",
      "obj.dnc-revocation",
      "script.intro",
    ],
  },
  {
    id: "obj.are-you-irs",
    part: "objections",
    section: "trust",
    title: "“Are you the IRS? Are you with the government?”",
    aliases: [
      "are you the irs",
      "are you with the government",
      "is this the irs calling",
      "are you a government agency",
      "do you work for the irs",
    ],
    lead:
      "They’re either scared this is collection contact or probing whether you have authority. The answer is a clear “no” with the distinction attached in the same breath: private firm, licensed to represent taxpayers BEFORE the IRS. Never imply any government affiliation.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Two very different people ask this question the same way. One is frightened — they think the IRS is finally calling to collect, and their heart rate just doubled. The other is testing your authority — if you’re not the government, what power do you actually have? A bare “no” fails both of them: it leaves the frightened one confused and the tester unimpressed. A bare “yes”-flavored dodge is worse — implying government affiliation is a serious compliance violation. The winning answer handles both in one breath: no, we are not the IRS — we’re the people licensed to stand between you and the IRS.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Answer the literal question first, plainly: “No — we’re not the IRS and we’re not the government.”",
          "Attach the distinction immediately: “We’re a private tax resolution firm, licensed to represent taxpayers before the IRS.” The word “before” does the work — you face the IRS on their behalf.",
          "If they sounded scared, ease it: not a collection call, no enforcement action is happening on this phone. Then pivot to what prompted the contact.",
          "If they sounded skeptical, the license IS the answer — representation rights (POA, enrolled practitioners) are exactly the authority they were probing for. See [[tax.representation]].",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "No — and that matters. We’re not the IRS and we’re not the government. We’re a private firm licensed to represent taxpayers BEFORE the IRS — we work for you, on your side of the table.",
          "Good question, and the answer is no. The IRS doesn’t call like this. We’re the ones you hire so that when the IRS does reach out, they’re talking to us instead of you.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "A bare yes/no with no context — it wastes the moment and leaves both the fear and the authority question unanswered.",
          "Implying ANY government affiliation, even softly (“we work with the IRS”) — that’s a compliance line, not a style choice.",
          "Missing the fear read — if they’re scared, launching into credentials without easing the collection panic loses them.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Well, we work with the IRS on tax matters, so in a sense we’re connected to that whole system…”",
        strong:
          "“No — and that matters. We’re not the IRS and we’re not the government. We’re a private firm licensed to represent taxpayers BEFORE the IRS — we work for you, on your side of the table.”",
        note:
          "The weak version blurs the government line — a genuine compliance violation dressed as a sales convenience, and it deepens the scam read. The strong version is a clean no with the distinction that actually sells: licensed representation means you never face the IRS alone. The truth here is more persuasive than the blur.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect asks, voice tight: “Wait — is this the IRS calling me?” — what’s your move?",
        answer:
          "Hear the fear and answer it first: “No — we’re not the IRS, this isn’t a collection call, and nothing is happening to you on this phone.” Then the distinction: private firm, licensed to represent taxpayers before the IRS. Then bridge: “The reason I’m calling is the inquiry you sent about the balance — is that still open?”",
      },
      {
        kind: "compliance",
        text:
          "Never state or imply government or IRS affiliation — not as a joke, not as a softener, not as “we work with the IRS.” The only accurate frame is a private firm licensed to represent taxpayers before the IRS, and that frame happens to be the stronger sell anyway.",
      },
    ],
    links: [
      "tax.representation",
      "strat.permission-legitimacy",
      "obj.scam-distrust",
      "script.intro",
    ],
  },
  {
    id: "obj.company-name-verify",
    part: "objections",
    section: "trust",
    title: "“What’s the name of your company? Spell it. What’s your address?”",
    aliases: [
      "what's the name of your company",
      "spell it",
      "what's your address",
      "what company are you with",
      "let me look you up",
      "what's your website",
      "give me your phone number",
    ],
    lead:
      "Treat the request as a verification gate, not automatic buying behavior. Give basic public identity cleanly, then test for reciprocal good-faith engagement before offering detailed company information or case-specific guidance.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "A request to verify the firm may be healthy skepticism, a privacy concern, a brush-off, or information fishing. Do not decide which from the question alone. Answer the public basics without hesitation, then ask one ordinary question about the tax issue. Good-faith prospects usually reciprocate over the next few exchanges. A person who will not provide any case information but keeps pressing for office details, internal information, or free tax analysis has not demonstrated a legitimate desire to interact. Verification earns a path to continue; it does not automatically earn every detail.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Give the public basics clearly: firm name, spelling, public website, main line, truthful reason for the call, and that we are not the IRS.",
          "Do not volunteer an office address, employee details, internal structure, direct contacts, or operational information merely because someone asks.",
          "After the public basics, ask one simple case question: do they actually owe, have unfiled returns, or have a notice? Read their willingness to reciprocate across the exchange.",
          "If they engage in good faith, continue progressively. If they only fish, offer the public verification path and end the call without accusation or debate.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Absolutely. It’s The Tax Group. Our public website and main line are [approved public details], and you’re welcome to verify us or call back through the front door.",
          "Before I go deeper, let me make sure this is a real fit: are you dealing with an IRS balance, unfiled returns, or a state issue?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Dodging the firm name, public website, main line, or truthful call reason. Basic identity is not conditional.",
          "Volunteering office addresses, staff information, internal details, or direct contacts before good-faith reciprocity is established.",
          "Treating every skeptical prospect as a bad actor. Read the pattern across several exchanges and respect ordinary privacy concerns.",
          "Giving individualized tax advice to keep an information-fishing caller engaged. Advice requires a legitimate prospect and enough verified facts.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Why do you need our information? You called us — answer my questions first.”",
        strong:
          "“Absolutely. It’s The Tax Group. Here are our approved public website and main line so you can verify us. Before I give you case-specific guidance, are you actually dealing with an IRS balance, unfiled returns, or a state issue?”",
        note:
          "The weak version turns caution into hostility and makes a legitimate prospect feel accused. The strong version provides public verification, then asks for one reciprocal fact before deepening the exchange. It protects the firm without acting evasive.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Hold on. Spell the company name for me. And where exactly are you located?” — what’s your move?",
        answer:
          "Give the firm name, spelling, public website, main line, and truthful call reason. Do not volunteer the office address or internal details yet. Then ask one reciprocal qualifying question about the actual tax issue. If they engage, disclose progressively; if they continue collecting information while refusing every case question, invite them to verify through the public channel and end cleanly.",
      },
    ],
    links: [
      "strat.earn-trust-with-proof",
      "obj.scam-distrust",
      "obj.how-can-i-trust",
      "script.intro",
    ],
  },
  {
    id: "obj.how-can-i-trust",
    part: "objections",
    section: "trust",
    title: "“I don’t know who you are — how can I trust you?”",
    aliases: [
      "how can i trust you",
      "i don't know who you are",
      "why should i trust you",
      "why do you need that information",
      "i'm not comfortable sharing that",
      "why do you need my social",
      "not giving you my information",
    ],
    lead:
      "They’re asking for a reason that isn’t a sales line — and when it’s about sharing their SSN or DOB, they’re asking why a stranger needs the keys to their identity. The answer is specifics they can verify, plus naming exactly what each piece of information is FOR.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This objection comes in two flavors that share one root. The general version — “how can I trust you?” — is a demand for something checkable: not warmth, not testimonials, a fact they can verify before sending a dollar. The sharper version arrives when you ask for sensitive information — “why do you need that? I’m not comfortable sharing that” — and underneath it is the entirely reasonable thought: are you a scammer, and why does a stranger need my SSN, my date of birth, my address? Both versions fail on reassurance and succeed on specifics. Trust is not requested on this call; it is earned in pieces, and you earn each piece by showing exactly what it buys.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Offer verifiable specifics, not vibes: the licensed professionals on staff (enrolled agents, tax preparers, other tax specialists), registration they can look up, and how the firm is paid — a clear fee for defined work, not a commission on debt reduction. See [[strat.earn-trust-with-proof]].",
          "Invite them to verify everything BEFORE committing anything: “check all of it before you send a dollar.” The invitation itself does most of the proving.",
          "When the objection is about sharing information: name the specific use case for the specific item — “the last four and your DOB are what the IRS requires to release your transcript to us; that’s how we see exactly what they have on you.”",
          "Affirm the caution — “you’re right to be careful with that” — and offer to take less first and earn the rest. Start with what they’re comfortable giving; the rest comes after the value shows up.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "You shouldn’t trust me yet — you’ve known me four minutes. Here’s what you can check: our licensed practitioners, our registration, and how we get paid — a flat fee for defined work, not a cut of your debt. Verify all of it before you send a dollar.",
          "Fair — here’s exactly why I’m asking: your date of birth and the last four are what the IRS requires before they’ll release your transcript to us. That transcript is how we see what they have on you. No other use, and you’re right to ask.",
          "Tell you what — give me the pieces you’re comfortable with, and we’ll earn the rest.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "“We’ve helped thousands of people” — unverifiable social proof answers nothing.",
          "“Trust me” or testimonials with no specifics — the exact register of every bad actor they’ve heard.",
          "“Because we need it” / “it’s required” when they ask why you need information — a non-answer that confirms the fear.",
          "An annoyed or impatient tone when they hesitate on PII — their caution is correct, and punishing it loses the call.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Ma’am, we need your social to move forward — it’s just required, it’s standard. We’ve helped thousands of people, you can trust us.”",
        strong:
          "“You’re right to be careful with that. Here’s exactly what it’s for: the IRS requires your DOB and last four before they’ll release your transcript to us — that’s how we see what they actually have on you. And check us out first: licensed practitioners, registration, flat fee. Verify it all before you send a dollar.”",
        note:
          "The weak version stacks a non-answer (“it’s required”) on unverifiable proof (“thousands of people”) with a pinch of impatience — the full scam-call bingo card. The strong version affirms the caution, names the specific use for the specific data, and hands over checkable facts. Specificity is the hardest thing for a fraudster to fake.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Whoa — why do you need my social security number? I’m not giving that to somebody who cold-called me.” — what’s your move?",
        answer:
          "Affirm the caution first — “good instinct, you shouldn’t hand that to a stranger.” Name the specific use: the IRS requires it to release their transcript, which is how you see what they actually owe. Then offer the smaller step: “let’s start with what you’re comfortable sharing — and look us up while we talk. The rest we’ll earn.”",
      },
    ],
    links: [
      "strat.earn-trust-with-proof",
      "strat.expert-specificity",
      "psych.cialdini.authority",
      "obj.company-name-verify",
      "script.info",
    ],
  },
  {
    id: "obj.how-got-number",
    part: "objections",
    section: "trust",
    title: "“How did you get my number?”",
    aliases: [
      "how did you get my number",
      "how did you get my information",
      "where did you get my info",
      "who gave you my number",
      "how do you have my number",
    ],
    lead:
      "The most common outbound-killer, usually in the first thirty seconds. Specificity — source, date, partial email — is far and away your strongest answer, because vagueness reads as “scam.” Have that answer ready before you dial; without it, this call is brutally hard to save.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This is a legitimacy gate, not hostility. They may genuinely not remember a form they filled out at 2am three weeks ago, and in a world of data breaches and robocalls, “how do you have my number?” is exactly what a careful person asks. Here’s the asymmetry that decides the call: you have receipts — the source, the date, the partially-masked email — and delivering them calmly IS the trust-builder. A vague answer (“you’re in our system,” “from our database”) is indistinguishable from a scammer’s answer, because a scammer would say exactly that. This objection is won or lost before the phone rings: have the opt-in data in front of you when you dial.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Answer with the actual opt-in data: source + date + partially-masked email or address. Precision is the whole play.",
          "Offer the confirmation: “I can tell you what email you used so you can confirm it’s the right form.” Receipts, offered freely, end the suspicion.",
          "Then bridge immediately to their issue — don’t linger in the defensive register. The question was a gate; once you’re through it, walk. See [[strat.anchor-to-inquiry]].",
          "If they still don’t recall and demand removal, honor it cleanly and unbothered — that’s TCPA, and it’s [[obj.dnc-revocation]], not a play.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "You filled out a tax-relief inquiry on the 4th — it came in under j***@gmail. That’s why I’m calling and not a robot. The form mentioned back balances — is that still live?",
          "You filled out a form on Facebook about three weeks back asking about tax help — we follow up with people who reach out to us. If you’d like, I can tell you the email you used so you can confirm it’s the right form.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Vague answers: “from our system,” “you’re in our database” — those are scam answers, and they’re heard as scam answers.",
          "Any defensiveness — the question is fair; treat it as fair.",
          "“You requested this call” with no specifics — they’ll push back, and now you’re arguing instead of proving.",
          "Lingering in the defensive register after you’ve answered. Prove it, then move.",
        ],
      },
      {
        kind: "example",
        weak:
          "“You’re in our system as someone who requested information. Anyway, the reason for my call today—”",
        strong:
          "“You filled out a tax-relief inquiry on the 4th — it came in under j***@gmail. That’s why I’m calling and not a robot. The form mentioned back balances — is that still live?”",
        note:
          "The weak version gives the database non-answer and plows into a pitch — the gate stays shut and the hang-up follows. The strong version delivers receipts (source, date, masked email), explains itself in one line, and bridges straight to their issue. Specificity opens the gate; momentum carries you through it.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect interrupts your intro: “Hold on — how did you even get this number?” — what’s your move?",
        answer:
          "Give the receipts calmly: the source, the approximate date, the masked email. Offer to confirm the email so they know it’s real data, not a guess. Then bridge without pausing: “the form mentioned a back balance — is that still sitting there?” If they demand removal instead, confirm it immediately — that’s the DNC line, not a negotiation.",
      },
      {
        kind: "compliance",
        text:
          "If the answer to your receipts is a removal demand — “take me off, stop calling” — that is a TCPA revocation. Honor it fast and unbothered, confirm it out loud, and end the call. Never re-pitch past it.",
      },
    ],
    links: [
      "obj.dont-remember-signup",
      "obj.dnc-revocation",
      "strat.anchor-to-inquiry",
      "script.intro",
    ],
  },
  {
    id: "obj.dont-remember-signup",
    part: "objections",
    section: "trust",
    title: "“I don’t remember signing up for anything”",
    aliases: [
      "don't remember signing up",
      "never signed up",
      "didn't sign up",
      "i never filled anything out",
      "don't remember filling out a form",
      "i didn't request this",
    ],
    lead:
      "Often literally true — they filled out a form weeks ago and forgot; sometimes they’re testing you. The play is the partial reveal: enough masked detail to jog memory and prove you have real data, never a full PII dump. You’re proving, not arguing.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Take this one at face value first: online forms blend together, and a 2am “get tax help” form is exactly the kind of thing a stressed person fills out and forgets. Sometimes it’s a test — they remember fine and want to see whether you actually have their information or you’re fishing. The partial reveal answers both at once. A masked email (“starts with j, ends in @gmail”) and the debt range they indicated jogs a real memory, and proves to a tester that you hold real data — a guesser can’t produce either. What you must never do is argue the point (“but you DID fill it out”) or dump their full information to force the recall. Arguing makes it adversarial; a full PII dump is both a data-handling failure and, ironically, exactly what a scammer with a purchased list would do.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Normalize the forgetting first: “that happens a lot — these forms blend together.” No accusation, no insistence.",
          "Partial reveal, never full: the masked email, the approximate date, the debt range they indicated. Enough to jog memory and prove the data is real — nothing more.",
          "Ask the confirming question and let THEM close the gap: “does any of that ring a bell?” Their own memory doing the work tends to beat your assertion.",
          "Once it rings — or even if it half-rings — bridge to the issue itself: the balance is real whether or not the form is remembered. If it hardens into a removal demand instead, honor it.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "That happens a lot — these forms blend together, especially if you filled out a few. You used an email that starts with j and ends in @gmail, and you indicated you were dealing with somewhere around [the range from their inquiry] in tax debt. Does any of that ring a bell?",
          "No worries either way — the form’s not the point, the balance is. Is the back-tax issue itself still sitting there?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Arguing the point or doubling down — “but you DID fill it out” turns a memory gap into a fight.",
          "Sounding accusatory. They didn’t do anything wrong by forgetting.",
          "Revealing full PII to jog their memory — never read out a full email, SSN, address, or DOB. Partial reveal is enough, and it’s the only version that’s safe.",
          "Getting stuck relitigating the form when the real subject is the tax balance behind it.",
        ],
      },
      {
        kind: "example",
        weak:
          "“No, you definitely signed up — I’m looking right at it. It was submitted from johnsmith1974@gmail.com, address 4412 Elm Street. You put down that you owe $27,500. So anyway—”",
        strong:
          "“That happens a lot — these forms blend together. You used an email that starts with j and ends in @gmail, and you indicated somewhere in the twenty-to-thirty range on the debt. Ring a bell?”",
        note:
          "The weak version argues AND dumps full PII — it feels invasive, it hands sensitive data to whoever answered the phone, and it still doesn’t make them remember. The strong version normalizes the gap, proves the data is real with masked fragments, and lets their own memory do the confirming. Partial reveal is both the safer play and the more convincing one.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I never signed up for anything — I don’t know what you’re talking about.” — what’s your move?",
        answer:
          "Normalize, then partial-reveal: “Happens a lot — these forms blend together. The one I have came in under an email starting with j at gmail, indicating around $25k in tax debt. Does that ring a bell?” If it clicks, bridge to the balance. If they escalate to “take me off your list,” that’s a removal demand — confirm it and end cleanly. Never read out full PII to win the argument.",
      },
    ],
    links: [
      "obj.how-got-number",
      "obj.dnc-revocation",
      "strat.anchor-to-inquiry",
      "script.intro",
    ],
  },

  // ── DECISION ────────────────────────────────────────────────────────────────
  {
    id: "obj.need-to-think",
    part: "objections",
    section: "decision",
    title: "“I need to think about it”",
    aliases: [
      "think about it",
      "need some time",
      "sleep on it",
      "mull it over",
      "let me think",
      "not ready to decide",
      "give me a few days",
      "need to process",
    ],
    lead:
      "Usually not about thinking — more often it’s an unvoiced concern (price, trust, fear of commitment) they’d rather not say out loud. Your job is surfacing WHICH one, gently, and answering that — because “thinking” never calls back.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Nobody hangs up, sits in a quiet room, and thinks. “I need to think about it” is the polite wrapper around a specific hesitation the prospect doesn’t want to voice — usually the fee, sometimes doubt that this will actually work, occasionally fear of committing to anything at all. If you let the wrapper stand, you’re releasing the call to a coin flip you will lose: the unvoiced concern hardens overnight, the urgency fades, and the callback never happens. Thinking is fine; thinking about the RIGHT question is the service you provide. Isolate the real hesitation before you let go of the call.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Isolate immediately: “usually when someone says that it’s one of two things — the cost, or whether this will actually work. Which is closer?” Then answer THAT objection and advance. See [[strat.isolate]].",
          "Conditional close: “if we sorted that piece out right now, would you be ready to get started today?” — commits them to the real blocker, so answering it actually closes something.",
          "Attach a consequence clock: deadlines on notices don’t pause for thinking — what exactly would they know tomorrow that they don’t know now?",
          "Keep collecting while they “think”: “while you’re weighing it, let me at least tell you what the transcripts would show” — the conversation continuing IS the advance.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Sure — and usually that means one of two things: the fee, or whether this actually works. Which one are we really talking about?",
          "What would you know tomorrow that you don’t know right now? That CP504 deadline doesn’t take the night off. Let’s figure out the real question while I have you.",
          "If the fee piece made sense, is there anything else stopping you from getting this moving today?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Accepting the wrapper at face value and offering to “follow up next week” — you just scheduled a no.",
          "Answering objections they haven’t raised — pitching price, trust, and process all at once answers five objections that were really one.",
          "Pressuring the stall instead of naming it — pushing on “think about it” without isolating just hardens the wall.",
          "Ending the call the moment they say it. The conversation continuing is the advance; keep discovery moving while they weigh it.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Sure, no problem — it’s a big decision! Why don’t I give you a few days and follow up on Friday?”",
        strong:
          "“Sure — and usually that means one of two things: the fee, or whether this actually works. Which one are we really talking about? Because if it’s the fee and we sorted that piece out right now, is there anything else stopping you from getting this moving today?”",
        note:
          "The weak version validates the wrapper and volunteers the exit — Friday’s callback goes to voicemail. The strong version names the two likely blockers, makes it safe to admit one, and stacks a conditional close on it so the answer actually moves the deal. You can’t answer a concern they haven’t voiced; isolation gets it voiced.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “This all sounds good, but I want to sleep on it.” — what’s your move?",
        answer:
          "Isolate, then conditionally close: “Fair — and usually that means the fee, or whether this actually works. Which is closer?” When they name it, answer that one concern and ask: “if we sorted that right now, would you be ready to get started today?” If they still hold, attach the clock — what will they know tomorrow that they don’t know now? — and keep discovery moving while they think.",
      },
    ],
    links: [
      "strat.isolate",
      "strat.alternative-choice",
      "strat.dissolve-stall",
      "strat.cost-of-waiting",
      "obj.cant-decide-now",
      "script.close",
    ],
  },
  {
    id: "obj.spouse-consult",
    part: "objections",
    section: "decision",
    title: "“I need to talk to my wife / husband first”",
    aliases: [
      "talk to my wife",
      "talk to my husband",
      "ask my wife",
      "ask my husband",
      "my spouse",
      "talk it over with",
      "we make decisions together",
      "check with my partner",
      "talk to my family first",
      "talk to my accountant first",
      "talk to my lawyer first",
    ],
    lead:
      "Sometimes genuine — on a joint return the spouse is legally involved — often a soft exit. Either way the play is the same: make the consult happen NOW, on this call, instead of releasing to a maybe. The spouse isn’t an obstacle; on a joint return they’re a party.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Two things can be true. Some couples genuinely decide together, and on a joint return the spouse isn’t a bystander at all — they carry their own liability, which makes this legally THEIR conversation too. And some prospects reach for the spouse as the polite way off the phone. The tell that separates them: a genuine consult has logistics — she’s home at six, he’s off Thursdays — while a dodge stays vague. But here’s what makes this objection different from most: you don’t actually need to diagnose it, because the correct play is identical either way. The consult isn’t a reason to end the call; it’s the next step OF the call. Get the spouse on the line now, or lock the three-way to a specific hour — never release to “I’ll talk to her and get back to you.”",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Qualify the gate first: “do you need their sign-off, or do you two just like to talk things through?” — separates a decision-gate from a comfort ritual.",
          "Get them on the line NOW: “are they home? Grab them — I’d rather explain this once to both of you than have you retell it.” Immediate conference beats any callback. See [[strat.loop-in-decision-maker]].",
          "If truly unavailable: lock a specific three-way time TODAY or tomorrow — day, hour, both parties — and keep collecting case info in the meantime (“so I’m ready for that call, which years are unfiled?”).",
          "Joint-return leverage: the spouse’s own exposure (joint liability) makes this THEIR conversation too — tonight, not someday.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Is she home right now? Put her on — this is her balance too on a joint return, and I’d rather both of you hear it once than have you translate it over dinner.",
          "Do you need her okay, or do you two just talk things through? Either way — grab her, this takes ten minutes with both of you on.",
          "If she’s at work, let’s set the three of us for 6 tonight. And while I have you — so I’m ready for that call — which years are we dealing with?",
        ],
      },
      {
        kind: "avoid",
        items: [
          "“Why can’t you decide for yourself?” — challenging the marriage loses the prospect and the spouse in one sentence.",
          "Trying to bypass the spouse or close around them — if they’re a real gate, anything closed without them unwinds by morning.",
          "Agreeing and ending the call with a vague “let me know what she says” — that’s releasing to a maybe, and maybes don’t call back.",
          "Forgetting the ask: a “callback later this week” is not a play. Day, hour, both parties on the line — or it didn’t happen.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Totally understand — family decisions are important. Talk it over with her and give me a call back whenever you’ve had a chance.”",
        strong:
          "“Is she home right now? Put her on — this is her balance too on a joint return, and I’d rather both of you hear it once than have you translate it over dinner. If she’s at work, let’s set the three of us for 6 tonight — and while I have you, which years are we dealing with?”",
        note:
          "The weak version releases the call to a secondhand retelling — the spouse hears a worse pitch than you’d ever give, delivered by someone who can’t answer questions, and the maybe dies quietly. The strong version makes the consult the next step of THIS call: conference now, or a locked three-way with a day and an hour, with discovery still moving in the meantime. When the agent asks warmly and concretely, the spouse usually IS reachable.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “This sounds right, but my wife and I make these decisions together.” — what’s your move?",
        answer:
          "Qualify, then conference: “Do you need her okay, or do you two just talk things through? Either way — is she home? Grab her; on a joint return this is her balance too, and I’d rather explain it once to both of you.” If she’s truly unavailable, lock the three-way — “tonight at 6 or tomorrow at 10?” — and keep collecting case facts so you’re ready for that call.",
      },
    ],
    links: [
      "strat.loop-in-decision-maker",
      "strat.alternative-choice",
      "strat.isolate",
      "script.close",
    ],
  },
  {
    id: "obj.send-email",
    part: "objections",
    section: "decision",
    title: "“Just send me something / email me the info”",
    aliases: [
      "send me an email",
      "email me",
      "send me something",
      "send me the information",
      "mail me something",
      "send it in writing",
      "send me details",
      "send me the paperwork",
    ],
    lead:
      "A polite exit ramp — emails to cold prospects convert near zero. But refusing reads as evasive, so the play is agree AND keep the call alive: ask what specifically they want to see, send it while they’re still on the line, and put a callback on it.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Two people ask for the email. Most want off the phone, and the email is the socially acceptable way to end a call without saying no — that email will never be opened. A few genuinely want to verify you in writing before going further — and for them the email is a real trust step. You can’t always tell which one you have, so the play handles both: agree instantly (refusing flatly confirms the scam read), then make the email WORTH something. The pivot question is “what specifically do you want to see?” — a dodger has no answer, a verifier names the engagement letter or the fee schedule. Best of all, send it live: an email that arrives while you’re still on the line converts a stall into a walkthrough.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Agree immediately and confirm the address — momentum preserved, evasion read avoided.",
          "Ask what specifically they want to see — engagement letter, services list, fee schedule. The answer tells you whether this is verification or an exit, and it scopes a real email instead of a brochure.",
          "While “pulling it up,” run one or two discovery questions: “so I send the right thing — is this IRS, state, or both?” Partial discovery before release is the toll for the email.",
          "Send it DURING the call when you can, stay on the line while it lands, and walk them through it. If it must go later, put a callback ON the email: “it’ll have a time on it — does Thursday morning work to walk through it?”",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Happy to. While I pull that up — so I send the right version — is this just IRS, or is the state involved too?",
          "I’ll send it as soon as we’re off the line, and I’ll put Thursday 10am on it to walk through questions. Fair?",
          "What should I make sure is in there — the engagement letter, the fee schedule, the list of what we actually do first? I’d rather send you the three pages you’ll read than the twenty you won’t.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Agreeing and just ending the call — nothing closes via cold email; an unaccompanied send is a hang-up with paperwork.",
          "Refusing flatly or dodging the request — that reads evasive and feeds every trust doubt they had.",
          "Sending a generic brochure blast. An email that doesn’t match what they asked to see proves you weren’t listening.",
          "Releasing the call with zero discovery. The questions you ask “to send the right thing” are the price of the exit.",
        ],
      },
      {
        kind: "example",
        weak:
          "“Sure, no problem! What’s your email? … Great, I’ll get that right out to you. Have a great day!”",
        strong:
          "“Happy to. While I pull that up — so I send the right version — is this just IRS, or is the state involved too? … Got it. It’ll be in your inbox before we hang up; stay on with me a second and I’ll walk you through the fee page, and I’ll put Thursday 10am on it for questions. Fair?”",
        note:
          "The weak version cheerfully executes the brush-off — the email lands in a graveyard inbox and the lead is gone. The strong version agrees just as fast but extracts discovery on the way, sends live so the email becomes a shared document instead of a goodbye, and attaches a specific callback. Same yes, completely different call.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Look, just send me the paperwork and I’ll look it over.” — what’s your move?",
        answer:
          "Agree instantly, then scope it: “Happy to — what specifically do you want to see: the engagement letter, the fee schedule, the first-30-days list?” Take one or two discovery questions “so I send the right version,” send it while they’re still on the line if you can and walk them through it, and lock the callback: “Thursday 10am to go through questions — fair?” Never just send and hang up.",
      },
    ],
    links: [
      "strat.dissolve-stall",
      "strat.commitment-language",
      "obj.need-to-think",
      "script.discovery",
    ],
  },
  {
    id: "obj.busy-bad-time",
    part: "objections",
    section: "decision",
    title: "“I’m busy / I’m driving / I’m at work”",
    aliases: [
      "i'm busy",
      "bad time",
      "at work right now",
      "i'm driving",
      "in a meeting",
      "can't talk right now",
      "call me later",
      "call me back",
      "i have a call coming in",
      "in the middle of something",
    ],
    lead:
      "Often literally true — and the most abused dodge. The differentiator: a real busy person will take a SPECIFIC callback; a dodger wants vagueness. Offer 90 seconds now or a locked time, get one micro-commitment before release, and if they’re driving, safety first.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Call it a 50/50 split: half the time real life genuinely intervened — they ARE driving, the meeting IS starting — and half the time “busy” is the exit that requires no confrontation. You don’t have to guess which, because the alternative-choice offer is itself the test. “Ninety seconds now, or 4:30 today — which?” A genuinely busy person picks one, because specific is easy to say yes to. A dodger squirms toward vagueness — “just… sometime later this week” — and now you know what you have. Either way, never fight for minutes they don’t have; convert the moment into a scheduled, expected call. And one non-negotiable: if they’re driving, the safety language comes first — no pitch is worth a wreck, and caring out loud is also the most human thirty seconds of the call.",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "If they’re driving: safety first — “don’t try to talk through traffic; when do you land somewhere you can pull over or sit down?” Lock the time against that.",
          "Offer the 90-second version OR a precise window: “two options — 90 seconds now, or 4:30 today. Which?” Don’t settle for a vague “later” — an unclocked “later” is usually a brush-off wearing a watch; convert it to a specific time. See [[strat.alternative-choice]].",
          "Get a micro-commitment before release: confirm the number and one fact (“is the balance still around 30?”). A prospect who confirms a fact has agreed to the next call.",
          "Log it and ACTUALLY call at the time — to the minute. Punctuality is the trust play: the callback that arrives exactly when promised is the first promise you keep.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Ninety seconds or I call you at 4:30 — your pick.",
          "Done — 4:30 it is. One thing so I’m ready: is this just the 2021 balance, or multiple years?",
          "Don’t talk through traffic on my account — when are you parked, 4:30 or 6? I’ll call you to the minute.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Plowing forward or holding them aggressively — pitching a person mid-merge loses the deal and deserves to.",
          "Begging for two minutes — begging sets the frame that your call is an imposition. It isn’t; it’s their inquiry.",
          "Letting them go with no follow-up plan, or accepting “later today” — vague callbacks are where deals go to die.",
          "Ignoring the stated obstacle. If they said “driving,” address driving — steamrolling it reads as script-reading.",
        ],
      },
      {
        kind: "example",
        weak:
          "“I totally understand you’re busy — this will just take two minutes, I promise. So, the reason for my call is our tax resolution program, which—”",
        strong:
          "“Fair — two options: I take ninety seconds right now to tell you if this is even worth your time, or I call you at 4:30 today. Which works? … 4:30 it is. One thing so I’m ready: is this just the 2021 balance, or multiple years?”",
        note:
          "The weak version begs for time and then steals it anyway — the stated obstacle was ignored, so the prospect stops listening on principle. The strong version respects the constraint, converts it into a specific choice, and takes a micro-commitment on the way out. The locked time plus the confirmed fact means the 4:30 call is expected, not cold — and calling at 4:30 sharp is the first promise you keep.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I’m driving right now, can you call me back?” — what’s your move?",
        answer:
          "Safety first, then lock it: “Don’t talk through traffic on my account — when are you parked, 4:30 or 6?” Get the specific time, confirm the number, and take one fact — “so I’m ready: one year or multiple?” Then call at that time to the minute. “Later” without a clock is a no; a locked time with a confirmed fact is an appointment.",
      },
    ],
    links: [
      "strat.alternative-choice",
      "strat.commitment-language",
      "obj.send-email",
      "script.intro",
    ],
  },
  {
    id: "obj.cant-decide-now",
    part: "objections",
    section: "decision",
    title: "“I can’t make this big of a decision right now”",
    aliases: [
      "can't make this decision right now",
      "this is a big decision",
      "too much to decide",
      "i'm overwhelmed",
      "this is a lot",
      "can't commit to something this big",
      "too much right now",
    ],
    lead:
      "They’re overwhelmed AND they don’t trust the process yet — the decision looks like one giant leap. The play is to shrink it: separate the immediate next step (transcripts, protection, compliance) from the big resolution decision, and never manufacture urgency to force the leap.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This is [[obj.need-to-think]]’s bigger, heavier cousin. Where “think about it” hides one specific concern, “I can’t make this big of a decision” is usually the honest truth: they’re staring at years of debt, a fee, a stranger on the phone, and a process they don’t understand, all compressed into what feels like one irreversible leap. The mistake is treating the size of the feeling as something to bulldoze. The insight that wins the call: they’re right that the big decision doesn’t have to happen right now — because the decision in front of them isn’t the big one. Choosing a resolution plan comes weeks from now, after the transcripts show the facts. The only decision on THIS call is whether to look: power of attorney, transcripts, a read of where they stand. Small step, reversible feeling, real motion.",
      },
      {
        kind: "prose",
        heading: "Real urgency vs fake urgency",
        text:
          "Tax cases have genuine clocks — a CP504 with a date on it, an active levy notice, penalties compounding monthly. When a real clock exists, name it plainly and let the fact do the pushing. What you never do is invent one: “we need to act today,” “the IRS will levy tomorrow if you don’t sign” — false urgency is the signature move of the firms that burned the people you talk to, and an overwhelmed prospect can smell it. Fake urgency destroys the trust you were slowly winning; real urgency, stated calmly, builds it. If there’s no clock on their case yet, the honest lever is accrual — the balance grows every quiet month — and that’s enough. See [[strat.calm-urgency]].",
      },
      {
        kind: "moves",
        heading: "The play",
        items: [
          "Affirm the right to deliberate — “you’re right, and you shouldn’t decide the whole thing today.” Agreeing disarms; it also happens to be true.",
          "Split the decision: the resolution plan is the big decision, and it comes LATER, informed by transcripts. The only decision now is the small first step — POA, transcripts, a compliance read.",
          "Shrink it to one action: “one signature that lets us see what the IRS sees. That’s it. Everything else comes after.”",
          "Anchor urgency only to what’s real: an actual notice deadline if one exists, otherwise the accrual math. Never a manufactured emergency.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "You’re right — and here’s the good news: nobody’s asking you to decide the whole thing today. The resolution plan is a decision for after we see your transcripts. The only question right now is whether we get to look.",
          "Forget the mountain for a second. Step one is one signature that lets us see what the IRS sees. That’s it. Everything else comes after — and you decide each step with the facts in front of you.",
          "I’m not going to tell you the IRS levies tomorrow — that’s not how this works, and anyone who says it is playing you. What IS true: the balance grew every quiet month this year. Looking costs you a signature.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "“We need to act today” — false urgency, and they can feel it.",
          "Implying the IRS will levy tomorrow if they don’t sign now — a compliance problem AND a trust-killer in one sentence.",
          "Restating the full engagement when they’re already overwhelmed — you just made the mountain taller.",
          "Dismissing the overwhelm (“it’s really not that big a deal”) — it is to them, and being told otherwise reads as salesmanship.",
        ],
      },
      {
        kind: "example",
        weak:
          "“I hear you, but honestly you can’t afford to wait — the IRS moves fast and if you don’t get started today, tomorrow could be too late. This decision has to happen now.”",
        strong:
          "“You’re right — and you shouldn’t decide the whole thing today. The resolution plan comes after we see your transcripts. The only decision right now is whether we get to look: one signature, power of attorney, and we pull exactly what the IRS has on you. The big decision gets made later, with the facts in front of you.”",
        note:
          "The weak version answers overwhelm with a manufactured emergency — the exact pattern of the firms that gave this industry its reputation, and the prospect hardens instantly. The strong version agrees with them, then splits the giant leap into one small, describable step and pushes the big decision to where it honestly belongs: after the facts. The overwhelmed buyer doesn’t need a shove; they need a smaller door.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “This is a lot. I can’t commit to something this big on one phone call.” — what’s your move?",
        answer:
          "Agree, then split: “You’re right — and nobody should decide the whole thing on one call. The resolution plan is a later decision, made off your transcripts. The only question today is whether we get to look: one signature, POA, and we see exactly what the IRS sees.” If a real notice deadline exists, name it calmly; if not, use the accrual truth. Never invent a clock.",
      },
      {
        kind: "compliance",
        text:
          "Never manufacture urgency — no “the IRS will levy tomorrow,” no “this offer expires today,” no invented deadlines. Real notice deadlines and real accrual may be stated plainly; anything beyond the facts is both a compliance violation and the fastest way to lose an overwhelmed buyer. And never promise what the resolution phase will produce — the next step is looking, not a result.",
      },
    ],
    links: [
      "strat.calm-urgency",
      "strat.next-phase-control",
      "strat.cost-of-waiting",
      "obj.need-to-think",
      "script.close",
    ],
  },
];
