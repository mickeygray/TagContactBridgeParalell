import type { ManualEntry } from "./types";

export const PSYCH_PRINCIPLES_ENTRIES: ManualEntry[] = [
  // ── Cialdini ────────────────────────────────────────────────────────────────
  {
    id: "psych.cialdini",
    part: "psychology",
    section: "cialdini",
    title: "Cialdini: the levers of automatic influence",
    aliases: ["influence", "cialdini", "persuasion principles", "compliance triggers", "click whirr"],
    lead: "Robert Cialdini spent decades studying why people say yes, and found that most compliance runs on a handful of automatic triggers — reciprocity, commitment, social proof, authority, liking, scarcity, unity. Learn the triggers, and learn the line Cialdini himself draws: use them only where they truthfully apply.",
    blocks: [
      {
        kind: "prose",
        heading: "Who taught it and what he found",
        text: "Robert Cialdini is a social psychologist who did something unusual for an academic: he went undercover. He trained as a car salesman, a fundraiser, a telemarketer, an ad writer — anywhere professional persuaders worked — and catalogued what actually moved people. The result was “Influence: The Psychology of Persuasion,” one of the most-cited books on the subject ever written. His core finding: people cannot deliberate over every decision, so the brain relies on shortcuts. When a trigger fires — an expert speaks, a favor is owed, a deadline looms — we tend to comply automatically. Cialdini called it “click, whirr”: the trigger clicks, and the fixed behavior pattern whirrs into motion, like a tape playing. That is not a flaw in people; it is how a busy mind survives. It works because the shortcut is usually right — experts usually do know more, deadlines usually do matter.",
      },
      {
        kind: "prose",
        heading: "The ethics line — from Cialdini himself",
        text: "Cialdini is emphatic about this, and it is the part most people skip. He distinguishes the “bungler” (who has real proof of value but never uses it), the “smuggler” (who fabricates triggers — fake deadlines, invented testimonials, borrowed credentials), and the “detective,” who studies the situation, finds which principles genuinely live there, and simply brings them to the surface. The smuggler wins once and poisons the well; the detective builds a client base. Cialdini argues the fabricated version is not just unethical — it eventually gets detected, and the discovered lie destroys the very trust the trigger was meant to build.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "For us the detective’s rule is not a preference — it is policy. Tax resolution is a regulated space, and every principle in this section already lives truthfully in our calls: the debt is real, the notice clock is real, the licensure is real, the pattern of past clients is real. That means we never need the smuggler’s version. The whole house method — [[strat.expert-specificity]], [[strat.earn-trust-with-proof]], [[strat.calm-urgency]] — is Cialdini’s principles applied honestly to a situation where they actually hold. Your job is to surface what is true, not to invent what is not.",
      },
      {
        kind: "lines",
        heading: "The detective’s stance, in floor voice",
        items: [
          "“I’m not going to invent a reason to move fast — the notice in your hand already gives you one.”",
          "“You don’t have to take my word for the process; this is what we do all day, for people in exactly your spot.”",
        ],
      },
      {
        kind: "compliance",
        text: "Every principle in this section carries the same spine: real scarcity only (the IRS’s clocks, not ours), true authority claims only, real social proof only. Never promise a result, an OIC, a dollar figure, or a date — we describe what WE do, never what the IRS will give.",
      },
    ],
    links: [
      "psych.cialdini.reciprocity",
      "psych.cialdini.commitment",
      "psych.cialdini.social-proof",
      "psych.cialdini.authority",
      "psych.cialdini.liking",
      "psych.cialdini.scarcity",
      "psych.cialdini.unity",
    ],
  },

  {
    id: "psych.cialdini.reciprocity",
    part: "psychology",
    section: "cialdini",
    title: "Reciprocity: give first, and give something real",
    aliases: ["reciprocation", "give to get", "free value first", "obligation"],
    lead: "Cialdini’s first principle: people feel obligated to repay what they receive. Give genuine value before you ask for anything, and the ask stops feeling like a pitch. On our floor the gift is knowledge — the free, clear explanation of what their notice actually means.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini calls reciprocation one of the most powerful weapons of influence because the obligation it creates is nearly universal — every human culture trains its members to repay favors, and people go to remarkable lengths to avoid feeling like a moocher. His famous illustrations: the Hare Krishna fundraisers who pressed a flower into a traveler’s hand before asking for a donation, and the survey researcher who doubled response rates by enclosing a small check WITH the request instead of promising payment after. Two details matter for a salesperson. First, the gift creates the obligation even when it was never requested — the receiver did not ask for the flower, and still felt the pull. Second, the rule can trigger unequal exchange: a small genuine favor often produces a much larger return. But the trigger only fires on something the receiver actually experiences as valuable. A gift that is obviously a sales device — the “free gift” everyone recognizes as bait — creates no obligation, only wariness.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "Our gift is expertise delivered before any ask. When a prospect reads you a notice number and you tell them plainly what a CP504 is, where it sits on the collections ladder, and what typically comes next — you have given them something the IRS letter itself did not: comprehension. Same with walking a transcript, or explaining what an SFR is to someone who never filed. That is real value; most of them have been carrying this letter around scared and confused for weeks. Give it freely, early, without holding it hostage to the sale. Reciprocity is why the [[script.expert]] phase exists before the pitch: by the time you present, they already owe you the courtesy of hearing it. It also compounds with trust — a caller who just gave you a straight, useful answer for free does not read as a scammer (see [[strat.earn-trust-with-proof]]).",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Before we talk about anything else — read me the number in the top corner of that letter and I’ll tell you exactly what it means and what usually comes after it. No charge for that; you should know what you’re holding.”",
          "“Here’s what that notice is really saying, in plain English — because the IRS certainly didn’t write it that way.”",
          "“Whether we end up working together or not, you’re going to get off this call understanding your situation better than you did ten minutes ago.”",
        ],
      },
      {
        kind: "avoid",
        heading: "What kills it",
        items: [
          "Dangling the explanation as bait — “I can tell you what that means AFTER we get you signed up” reverses the principle and reads as a shakedown.",
          "Fake gifts: a “free consultation” framed as a favor when it is obviously the sales call itself. Give something real inside the call instead.",
          "Invoicing the favor out loud (“I just spent twenty minutes helping you for free, so…”) — a called-in debt cancels the goodwill.",
        ],
      },
      {
        kind: "drill",
        prompt: "Two minutes in, the prospect says: “Look, before I tell you anything — what IS this letter? What does LT11 even mean?” What’s your move?",
        answer: "Answer it, fully and first. The LT11 is a final notice of intent to levy with appeal rights on a clock — explain that plainly, tell them where it sits on the ladder and what typically follows. You just gave real value before asking for anything; the obligation now runs your way, and the seriousness of what you explained honestly sets up the urgency. THEN resume discovery: “Now — so I can tell you what your options look like, how many years are we dealing with?”",
      },
    ],
    links: ["strat.earn-trust-with-proof", "strat.expert-specificity", "script.expert", "tax.collections-ladder"],
  },

  {
    id: "psych.cialdini.commitment",
    part: "psychology",
    section: "cialdini",
    title: "Commitment & consistency: small yeses bind",
    aliases: ["consistency", "micro-commitments", "small yes", "foot in the door", "self-persuasion"],
    lead: "Cialdini’s second principle: once people take a position — especially out loud, in their own words — they feel deep pressure to stay consistent with it. That is why a problem THEY state beats a problem you describe, and why the call is built as a ladder of small agreements.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini describes an almost obsessive human drive to be — and to appear — consistent with what we have already said and done. Once a stand is taken, we bend our behavior to justify it. His evidence runs from the foot-in-the-door studies (homeowners who agreed to display a tiny sign later accepted a huge one, because they now saw themselves as “people who care about this cause”) to a detail every salesperson should memorize: commitments are most binding when they are ACTIVE, PUBLIC, EFFORTFUL, and experienced as freely chosen. A position I wrote down or said aloud binds me far more than one I merely nodded at, and a position I chose binds me far more than one I was pushed into. The deepest version is self-persuasion: people do not argue with their own words. When the prospect states the problem, the case for solving it is now THEIRS.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "This is the engine under two house disciplines. First: get THEM to say it. “The garnishment is killing me” from the prospect’s mouth is worth ten minutes of you describing garnishments — which is exactly why the [[strat.pain-funnel]] ends with them stating the cost, and why Voss aims for “that’s right” (their own summary confirmed) over “you’re right” (your summary tolerated) — see [[psych.voss.thats-right]]. Second: build the ladder. Every phase closes on a micro-yes — yes, that’s my situation; yes, those are the years; yes, I want this handled — so that by [[script.payment]] the close is not a leap but the next consistent step in a series of positions they already took. And when their language shifts forward — “would” becoming “will,” “if” becoming “when” — the commitment has formed; stop selling and schedule ([[strat.commitment-language]], [[strat.take-the-yes]]).",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“So just so I have this right — in your words, what’s the part of this that worries you most?”",
          "“You said earlier the thing you couldn’t live with was them touching your paycheck. That’s exactly the thing we go to work on first.”",
          "“Sounds like you’ve already decided you’re not letting this ride another year — am I hearing that right?”",
        ],
      },
      {
        kind: "example",
        weak: "“Ma’am, your situation is serious. You owe for four years, the penalties are stacking, and if you don’t act they’ll levy. You need help.”",
        strong: "“Walk me through it — how long has this been hanging over you? … Four years. And what’s it been costing you, living with it? … So in your own words, what happens if it’s still sitting there next year?”",
        note: "The weak version is the agent’s position; the prospect can resist it. The strong version ends with the prospect stating the stakes themselves — and people do not argue with their own words. Every answer is a small commitment the close will later stand on.",
      },
      {
        kind: "drill",
        prompt: "The prospect has agreed with everything you said, nodding along — “yeah… uh-huh… right” — but has stated nothing themselves. Are you ahead?",
        answer: "No — you have compliance, not commitment. Passive nods are the weakest possible position; nothing they said binds them, and the “think it over” stall is coming. Hand them the microphone: “Tell me in your own words — what’s the piece of this that actually worries you?” Do not move to the pitch until the problem has come out of THEIR mouth.",
      },
    ],
    links: ["strat.take-the-yes", "strat.commitment-language", "psych.voss.thats-right", "strat.pain-funnel", "psych.sandler.pain-funnel"],
  },

  {
    id: "psych.cialdini.social-proof",
    part: "psychology",
    section: "cialdini",
    title: "Social proof: uncertain people follow similar others",
    aliases: ["social proof", "consensus", "most clients", "other people like you", "testimonials"],
    lead: "Cialdini’s third principle: when people are unsure what to do, they look at what others did — and the pull is strongest when those others are SIMILAR to them. “Most clients in your spot” works because it is true. Invented testimonials are the smuggler’s version, and they are off the table.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini’s social proof principle: we decide what is correct by finding out what other people think is correct — one reason canned laughter works on audiences who claim to hate it. He identifies the two conditions that turn the dial up. The first is UNCERTAINTY: when the situation is ambiguous and people do not trust their own read, they scan hardest for others’ behavior. The second is SIMILARITY: we follow the lead of people like us, not people in general. A testimonial from someone in a different life tells me little; “people in exactly my position did this” is nearly an instruction. Cialdini also warns about the dark inversion — pluralistic ignorance, where everyone stays frozen because everyone else looks frozen — which is precisely the state of a person who has been sitting on IRS notices for a year because nobody they know talks about tax debt.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "A tax-debt prospect is the textbook case: maximum uncertainty (they do not understand the notices, the process, or their options) and painful isolation (nobody advertises owing the IRS, so they think they are the only one). Honest social proof does two jobs at once. It guides — “most clients who come to us with an LT11 have us file representation first” tells them the normal next step. And it de-shames — “we talk to people in exactly your spot every single day” dissolves the embarrassment that keeps them from opening up ([[strat.shame-reduction]]). The compliance rule is absolute: the pattern you cite must be a real pattern from real cases. “We do this every day” is true. A specific invented success story is fabrication — the smuggler’s move — and it is also unnecessary, because the true patterns are plenty persuasive.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You’d be surprised how normal this is — most of the people we help sat on those letters for over a year before they called anyone. You’re actually ahead of the curve.”",
          "“Clients in your exact spot — same notice, same kind of balance — the first thing we do for them is get representation on file so the IRS talks to us instead of you.”",
          "“We do this every day. Nothing you’re about to tell me is going to be a first.”",
        ],
      },
      {
        kind: "avoid",
        heading: "The smuggler’s versions — off the table",
        items: [
          "Invented specifics: “I had a client last week who owed exactly what you owe and paid nothing” — fabricated, and a promised outcome besides.",
          "Dissimilar proof: citing a business 941 case to a wage earner. Similarity is the engine; match the proof to their situation.",
          "Numbers you cannot stand behind — made-up success rates or client counts. “Most,” “typically,” and “every day” are honest and strong.",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says: “I’ve never heard of anyone using a company like yours. Is this even a thing people do?” What’s your move?",
        answer: "That is uncertainty asking for proof — feed it the truth. “It’s a thing thousands of people do; you just never hear about it because nobody brags about owing the IRS. People in your exact position — same letters, same worry — call us every day, and the normal first step for them is getting representation on file so the IRS deals with us.” Real pattern, similar others, and it quietly de-shames them at the same time.",
      },
      {
        kind: "compliance",
        text: "Social proof must be real: actual patterns from actual cases, in honest quantifiers. Never invent a testimonial, a success story, or a statistic — and never let a proof story slide into promising their result.",
      },
    ],
    links: ["strat.earn-trust-with-proof", "strat.shame-reduction", "strat.human-reassurance", "tax.representation"],
  },

  {
    id: "psych.cialdini.authority",
    part: "psychology",
    section: "cialdini",
    title: "Authority: credentials and specificity read as expertise",
    aliases: ["authority", "expert", "credentials", "licensed", "enrolled agent", "form numbers"],
    lead: "Cialdini’s fourth principle: people defer to legitimate experts, and they read expertise through signals — titles, credentials, and above all command of specifics. Our authority is real: a licensed firm, enrolled agents, and form numbers we know cold. The compliance edge is simple: every authority claim must be true.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini opens his authority chapter with Milgram’s obedience experiments — ordinary people delivering what they believed were dangerous shocks because a man in a lab coat said the experiment required it — to show how deep the deference to authority runs. His point for persuaders is subtler than “act important.” Deference is triggered by SYMBOLS of authority: titles, uniforms, trappings — and, critically, by demonstrated expertise. Cialdini’s later work adds the refinement that matters most on a phone, where nobody can see a diploma: the most trusted authority is the CREDIBLE authority — expert AND trustworthy — and one of the fastest ways to establish trustworthiness is to be precise, and to concede a limitation honestly before making your strong claim. An expert who says exactly what a thing is called, and admits what he does not yet know, is believed on everything else.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "On a cold call our authority has to be built in the prospect’s ear, and specificity is how ([[strat.expert-specificity]]). “That’s a CP504 — that’s the notice before they can start looking at levy sources” demonstrates expertise in one sentence better than a paragraph of self-praise. The real credentials do the rest: a licensed firm, enrolled agents admitted to practice before the IRS, representation filed on Form 2848 ([[tax.representation]]). Name the forms; the numbers themselves carry the lab-coat effect, and they happen to be exactly true. The trust half of credible authority is honesty about limits: “I can’t tell you what the IRS will agree to until we see your transcripts” costs you nothing and buys belief for everything else you say. The line we never cross: no invented titles, no claiming to BE the IRS or to speak for it, no credentials we do not hold. False authority in this industry is not just smuggling — it is the exact scam the prospect already fears ([[obj.are-you-irs]]).",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“That letter is a CP504 — it matters which one it is, because that number tells me exactly where you are in their collections sequence.”",
          "“We’re a licensed tax-resolution firm. Enrolled agents — that’s a federal license to represent taxpayers before the IRS. When we file the Form 2848, they’re required to deal with us.”",
          "“I won’t pretend to know what they’ll agree to before we’ve seen your transcripts — anyone who promises you a number on this phone call is lying to you. What I can tell you is exactly what we do first.”",
        ],
      },
      {
        kind: "example",
        weak: "“Trust me, we’re the best in the business, we know everything about the IRS, we handle this stuff all the time.”",
        strong: "“You said it’s an LT11 — okay, that’s their final notice of intent to levy, and it starts a 30-day clock on your appeal rights. First thing we do is file a Form 2848 so they’re dealing with our enrolled agents instead of you.”",
        note: "The weak version claims authority; the strong one demonstrates it. Naming the notice, the clock, and the form does what “trust me” never can — and every word of it is true.",
      },
      {
        kind: "drill",
        prompt: "Prospect asks: “Are you guys even licensed? How do I know you’re not some boiler room?” What’s your move?",
        answer: "Welcome the question — a scam would dodge it. State the true credentials plainly: licensed firm, enrolled agents federally licensed to practice before the IRS, representation filed on Form 2848 which they can verify. Then add the credibility move — concede a limit: “And here’s how you can tell the difference: I’m not going to promise you a settlement number on a first phone call. Nobody honest can.” Precision plus an honest limitation reads as the real thing, because it is.",
      },
      {
        kind: "compliance",
        text: "Authority claims must be literally true: real licensure, real credentials, real form numbers. Never claim or imply IRS affiliation. And authority never extends to outcomes — we state what WE do (file representation, request holds, pursue the options the file supports), never what the IRS will grant or when.",
      },
    ],
    links: ["strat.expert-specificity", "tax.representation", "strat.earn-trust-with-proof", "obj.are-you-irs", "obj.licensed-question"],
  },

  {
    id: "psych.cialdini.liking",
    part: "psychology",
    section: "cialdini",
    title: "Liking: the ally against the problem",
    aliases: ["liking", "rapport", "similarity", "cooperation", "same side of the table"],
    lead: "Cialdini’s fifth principle: people say yes to people they like, and liking is built from similarity, genuine compliments, and — most usable on our floor — cooperation toward a shared goal. You are not across the table from the prospect; you and they are on the same side, against the IRS paperwork.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini catalogues what actually produces liking: physical attractiveness (not much use on a phone), SIMILARITY (we like people who resemble us — in background, speech, circumstances), COMPLIMENTS (praise works even when the receiver suspects the motive, though genuine and specific beats flattery), familiarity through repeated positive contact, and — the one he illustrates with the classic Robbers Cave summer-camp study — COOPERATION. Two groups of boys made into bitter rivals became friends only when forced to work together on shared problems. The sales translation Cialdini draws explicitly is the “good cop” structure of the car dealer who seems to fight the manager on your behalf: we like, and buy from, people who appear to be working WITH us against a common obstacle. The honest version of that move is available whenever a genuine common obstacle exists.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "We do not need to manufacture the common obstacle — the prospect has one, and it generates a hundred pages of it a year. The frame that changes the whole call: it is not you versus them about a fee; it is you and them versus the IRS machine — the notices nobody can read, the hold music, the compounding penalties. Every move that lands as genuine alliance builds liking: acknowledging how they are actually feeling instead of steamrolling to the pitch ([[strat.human-reassurance]]), letting them be embarrassed without judgment ([[strat.shame-reduction]]), the specific honest acknowledgment — “you’ve been carrying this alone for two years; that’s exhausting” — which is Cialdini’s compliment principle in its truthful form. Similarity you can use honestly: speak like a person, not a script; match their pace; if you genuinely share something, say so. What you never do is fake a biography — invented similarity is smuggling, and people smell it.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Just so we’re clear about what this call is — it’s not me selling you something. It’s the two of us figuring out how to get the IRS off your back. Different conversation.”",
          "“You and me versus that stack of paperwork — that’s the whole arrangement.”",
          "“Honestly? The fact that you picked up and you’re dealing with this head-on puts you ahead of most people. Most folks let it ride until the levy hits.”",
        ],
      },
      {
        kind: "avoid",
        heading: "What breaks the alliance",
        items: [
          "Arguing. The moment you and the prospect are debating, you are adversaries and liking is gone — agree first, always ([[strat.agree-first]]).",
          "Fake similarity — inventing a hometown, a hardship, a relative with tax trouble. Discovered once, it confirms every scam fear they had.",
          "Flattery with a visible hook: “someone as smart as you can see this is a great deal.” Compliments work when specific and true, not when they carry a price tag.",
        ],
      },
      {
        kind: "drill",
        prompt: "The prospect is bristly and short with you: “Let’s just get this over with — what are you selling?” How do you build liking with someone who starts hostile?",
        answer: "Do not match the heat, and do not grovel. Move to the shared-enemy frame immediately: “Fair enough — straight to it. You’ve got the IRS sending you letters, and my job is getting them to send those letters to us instead of you. So this isn’t me selling; it’s me finding out if there’s something worth taking off your plate.” Cooperation toward their goal, stated in one breath, converts an adversary frame into an alliance frame — which is the only soil liking grows in.",
      },
    ],
    links: ["strat.human-reassurance", "strat.shame-reduction", "strat.agree-first", "strat.light-warmth", "strat.hostility-resilience"],
  },

  {
    id: "psych.cialdini.scarcity",
    part: "psychology",
    section: "cialdini",
    title: "Scarcity: real clocks, and only real clocks",
    aliases: ["scarcity", "urgency", "loss aversion", "deadline", "fear of missing out", "loss framing"],
    lead: "Cialdini’s sixth principle: opportunities look more valuable as they become less available, and the fear of losing something moves people roughly twice as hard as the prospect of gaining it. Our floor’s edge: the scarcity in a tax case is REAL — notice deadlines, appeal windows, compounding penalties — so manufactured countdowns are both non-compliant and pointless.",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini’s scarcity chapter stands on two legs. The first is loss aversion, which he takes from Kahneman and Tversky’s prospect theory: losses loom larger than equivalent gains — as a rule of thumb, about twice as large. Tell a homeowner what insulation will SAVE them and you persuade some; tell them what leaving it uninsulated is LOSING them each month and you persuade far more. The second leg is psychological reactance: when a freedom or option is being taken away, we want it more, precisely because it is going. Deadlines and dwindling availability trigger both at once. Cialdini is equally clear about the failure mode — the “limited time offer” that turns out to be permanent is the fastest way to be recategorized as a huckster, because a fake deadline, once discovered, retroactively poisons every true thing you said before it.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "Here is the gift of this industry: the scarcity is built into the situation, and it is documented on paper the prospect is holding. The collections ladder ([[tax.collections-ladder]]) IS a countdown — a CP504 escalates to an LT11, an LT11 carries a genuine 30-day window on appeal rights, penalties and interest compound monthly, and options genuinely narrow at each rung: things you can do before a levy that you cannot do after. So the house play is [[strat.calm-urgency]]: state the real clock, calmly, and let the situation supply the pressure — the urgency lives in the facts, never in your tone. Frame it as loss, because loss is what is true and what moves: not “acting now could improve things” but “every month this sits, the balance grows and the options shrink” ([[strat.cost-of-waiting]]). What we never do: invent expiring fees, “this price is only good today,” fake case-load slots. Manufactured pressure is non-compliant, it is the pattern of every scam they have been warned about — and it is unnecessary, because the IRS has already written the deadline for you.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“I’m not going to pressure you — I don’t need to. That letter has its own deadline printed on it. My job is making sure you don’t lose the options that expire with it.”",
          "“Here’s the honest math: every month this sits, penalties and interest are stacking on top of what you already owe. Waiting isn’t neutral — waiting is the expensive option.”",
          "“There are things we can do at this stage that are simply off the table once a levy lands. That’s not a sales line; that’s how their process works.”",
        ],
      },
      {
        kind: "example",
        weak: "“I can only hold this fee until end of business today, and my manager’s only letting me take two more clients this month — so we really need to move right now.”",
        strong: "“Take a breath — nothing about MY offer expires today. But that LT11 in your hand starts a 30-day clock on your appeal rights, and that clock doesn’t care when you feel ready. Every month you wait, the balance grows and the options shrink. That’s the only urgency here, and it’s real.”",
        note: "The weak version is manufactured scarcity — non-compliant, scam-patterned, and brittle. The strong version is pure loss framing on a documented clock: calm delivery, real deadline, and it is MORE urgent, not less, because the prospect can verify every word.",
      },
      {
        kind: "drill",
        prompt: "Prospect says: “This has been sitting for three years — another month won’t make a difference.” What’s your move?",
        answer: "Loss-frame the truth. “Actually, the month makes a very specific difference — penalties and interest compounded every one of those thirty-six months, which is a big part of why the number is what it is now. The last three years already cost you real money; the question is whether month thirty-seven does too. And if that letter is a final notice, this month is the one where appeal options can expire.” No pressure in the tone; all of it in the facts.",
      },
      {
        kind: "compliance",
        text: "Real scarcity only: cite the IRS’s clocks — notice deadlines, appeal windows, compounding penalties — never invented ones. No expiring fees, no fake slots, no “today only.” And a real deadline still never becomes a promised outcome: the clock is theirs; the result is never guaranteed by us.",
      },
    ],
    links: ["strat.calm-urgency", "strat.cost-of-waiting", "tax.collections-ladder", "strat.reduction", "obj.no-urgency"],
  },

  {
    id: "psych.cialdini.unity",
    part: "psychology",
    section: "cialdini",
    title: "Unity: the “we” that runs deeper than liking",
    aliases: ["unity", "we", "shared identity", "one of us", "in-group"],
    lead: "Cialdini’s seventh principle, added decades after the first six in “Pre-Suasion”: beyond liking someone is BEING of them — shared identity. People say yes to “one of us.” Our honest version: the working taxpayer up against a bureaucracy, and an agent who genuinely stands inside that “we.”",
    blocks: [
      {
        kind: "prose",
        heading: "The principle, in Cialdini’s terms",
        text: "Cialdini added unity as the seventh principle in “Pre-Suasion” (2016), and he is careful to distinguish it from liking. Liking is about a positive relationship with someone OUTSIDE yourself; unity is about identity — the categories where the line between me and you blurs into WE. Family, tribe, region, shared struggle: the influence trigger is not “this person is pleasant” but “this person is one of us,” and Cialdini shows it moving behavior that mere liking never touches — people agree with, trust, and help in-group members at rates that look irrational from outside. He points at two honest routes into the “we”: shared IDENTITY that already genuinely exists (surface it), and acting TOGETHER — co-creation and joint effort build unity even between strangers. The warning is the same as always: a claimed kinship that turns out fake reads as the deepest betrayal, precisely because unity ran deeper than liking.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "The honest “we” is sitting right there in every call: working people versus a bureaucracy no working person can navigate alone. The prospect drives a truck, runs a shop, does payroll for a crew — and is being processed by a machine that communicates in notice codes. You genuinely stand on their side of that line: you deal with the machine every day, on behalf of people exactly like them, and the entire product is “the IRS talks to US now.” Say the “we” and mean it. Unity is also the deep version of the [[psych.cialdini.liking]] alliance frame — “you and me versus the paperwork” is cooperation; “people like us don’t have a tax lawyer on retainer, and that’s exactly who we exist for” is identity. Acting-together builds it too: walking the notice together, pulling the transcript together — every joint step makes the WE more real. The line: never fake a biography or a hardship to claim kinship. The categories you can honestly claim — working people, taxpayers, people who fix problems instead of hiding from them — are plenty.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“People like you and me don’t have a tax attorney on speed dial — that’s exactly the gap we exist to fill.”",
          "“You spent thirty years paying in and one bad stretch put you behind — that doesn’t make you a tax cheat, it makes you a working person the machine caught up with. Those are the people we represent.”",
          "“Let’s pull this apart together — you read me what the letter says, and I’ll tell you what it means.”",
        ],
      },
      {
        kind: "drill",
        prompt: "Prospect says: “You’re a collections company just like them — you’re all on the same side.” What’s your move?",
        answer: "That is a unity challenge — they have put you in the machine’s in-group. Redraw the line truthfully: “I get why it feels that way — everyone who calls about taxes sounds the same at first. But the IRS collects FROM you; we get hired BY you. When we file representation, the law makes them deal with us instead of you — we literally sit on your side of the table, and it’s the only side we ever sit on.” Then act together immediately — “read me the notice number and let’s see what we’re actually dealing with” — because joint action builds the WE faster than any claim.",
      },
    ],
    links: ["psych.cialdini.liking", "strat.human-reassurance", "strat.shame-reduction", "tax.representation", "obj.scam-distrust"],
  },

  // ── Sandler ─────────────────────────────────────────────────────────────────
  {
    id: "psych.sandler",
    part: "psychology",
    section: "sandler",
    title: "Sandler: break the buyer-seller dance",
    aliases: ["sandler", "sandler selling system", "doctor frame", "equal business stature", "buyer seller dance"],
    lead: "David Sandler built his system on one observation: buyers and sellers are locked in a ritual dance — the seller chases, the buyer stalls, everybody lies a little. Sandler’s answer: refuse to dance. Qualify like a doctor diagnosing, hold equal stature, and be genuinely willing to hear no.",
    blocks: [
      {
        kind: "prose",
        heading: "Who taught it and what he claimed",
        text: "David Sandler was a Baltimore businessman who lost everything, took a commission sales job, and got tired of losing the traditional way — pitch hard, chase, get stalled, chase more. The system he built (and franchised into one of the most-taught sales methodologies in the world) starts from a diagnosis of the RITUAL: the buyer’s side of the dance is mislead the salesperson, extract free information, hide the truth about money and intent, and disappear behind “I’ll think it over.” The seller’s side — eager pitching, feature-dumping, chasing — actually FEEDS the ritual, because pressure teaches the prospect to defend. Sandler’s prescription is to break the pattern entirely. His signature frames: the seller as DOCTOR — a physician diagnoses before prescribing, is not offended by symptoms, and does not beg you to accept treatment; EQUAL BUSINESS STATURE — you are a professional conducting an evaluation, not a supplicant hoping for scraps; and the rule that no is a perfectly acceptable answer — the only unacceptable outcome is a fake yes or an endless maybe. Sandler-isms worth keeping verbatim: “you can’t lose anything you don’t have,” and the instruction to go for the no — because a real no frees you, while a polite maybe owns you.",
      },
      {
        kind: "prose",
        heading: "Why the contrarian calm fits this floor",
        text: "Our prospects have been trained by every robocall and scam warning to expect a pusher. When the push does not come — when the voice on the phone is calm, asks questions a doctor would ask, and is visibly willing to conclude “this might not be for you” — the prospect’s defense script has nothing to grab. That pattern-break IS the persuasion. It is also simply the truthful posture: we genuinely are diagnosing (the notice, the years, the balance, the transcript decide what we can do), and a person whose situation does not fit genuinely should not buy. Sandler’s stature rule has one house translation above all: never apologize for the fee, and never beg. A doctor does not discount the surgery to win your approval.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "The three Sandler tools each have a house play built on them. The pain funnel ([[psych.sandler.pain-funnel]]) runs discovery — pain, not interest, is what buys, and [[script.discovery]] is structured to find it. The negative reverse ([[psych.sandler.negative-reverse]]) is the [[strat.takeaway]] — the gentle step-back that makes a defensive prospect argue your side. The up-front contract ([[psych.sandler.upfront-contract]]) is how we pre-empt “let me think about it” by agreeing at the start what a decision looks like. And equal stature runs under [[strat.confident-value-frame]]: the fee is the fee, the process is the process, and we present both like the professionals we are.",
      },
      {
        kind: "lines",
        heading: "The Sandler posture, in floor voice",
        items: [
          "“Before I can tell you whether we can even help, I need to ask you what a doctor would ask — what’s going on, how long, and what’s it been costing you. Fair?”",
          "“I’m not here to talk you into anything. If what I find says we can’t move the needle for you, I’ll tell you that too.”",
          "“No is a fine answer — I’d rather have a real no today than a maybe that wastes your next three weeks.”",
        ],
      },
      {
        kind: "drill",
        prompt: "You feel yourself chasing — talking faster, stacking benefits, filling every silence — and the prospect gets quieter the harder you push. What is happening, in Sandler’s terms, and what is the fix?",
        answer: "You have joined the dance: seller pressure is feeding buyer defense, and their silence is the buyer’s side of the ritual. Break the pattern — stop pitching, drop back to doctor posture, and ask a diagnostic question: “Let me stop myself — I’m telling you things and I haven’t even asked: what’s this debt actually been doing to you month to month?” The moment you return to diagnosing, the stature resets and the defense has nothing to push against.",
      },
    ],
    links: ["psych.sandler.pain-funnel", "psych.sandler.negative-reverse", "psych.sandler.upfront-contract", "strat.takeaway", "strat.confident-value-frame", "script.discovery"],
  },

  {
    id: "psych.sandler.pain-funnel",
    part: "psychology",
    section: "sandler",
    title: "The pain funnel: pain buys, interest browses",
    aliases: ["pain funnel", "pain questions", "tell me more", "what's it costing you", "emotional discovery"],
    lead: "Sandler’s most famous tool: a graduated ladder of questions — tell me more, how long, what have you tried, how did that work, what has it cost you, how do you feel about that — that walks a prospect from a stated problem down to its felt cost. People buy emotionally and justify intellectually; the funnel finds the emotion.",
    blocks: [
      {
        kind: "prose",
        heading: "The tool, in Sandler’s terms",
        text: "Sandler taught that prospects buy for THEIR reasons, not yours, and that the reason is almost never the surface complaint — it is the pain underneath it. “No pain, no sale” is the blunt Sandler formulation. But pain is layered: the first statement of a problem is intellectual (“I owe some back taxes”), and intellect browses without buying. The funnel is a deliberate sequence that deepens by degrees: TELL ME MORE ABOUT THAT (open the topic) → CAN YOU BE MORE SPECIFIC / GIVE ME AN EXAMPLE (make it concrete) → HOW LONG HAS THIS BEEN A PROBLEM (extend it in time) → WHAT HAVE YOU TRIED TO DO ABOUT IT (surface failed attempts — this also quietly disqualifies “I’ll just handle it myself”) → HOW DID THAT WORK (let them say it didn’t) → WHAT HAS THAT COST YOU (make the price of the problem explicit) → HOW DO YOU FEEL ABOUT THAT (arrive at the emotion) → HAVE YOU GIVEN UP TRYING TO FIX IT (the bottom — resignation or resolve). Each rung only works because the previous one opened it; you cannot ask a stranger how they FEEL about their debt, but you can ask someone who just told you what three years of it has cost. The discipline: the funnel is questions, not statements. The prospect must SAY the pain — Sandler and [[psych.cialdini.commitment]] agree completely on why: a self-stated problem is owned; a described one is deniable.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "This funnel is the spine of [[script.discovery]] and the house play [[strat.pain-funnel]] is its direct implementation. A tax-debt prospect always presents intellectually — a number, a letter, a year. The pain is underneath: the garnishment fear before every payday, the marriage strain, the business account they are scared to grow because the IRS might take it, the shame of not opening mail. The funnel’s middle rungs are gold here: “what have you tried?” surfaces the CPA who only files returns, the IRS hold music they gave up on, the other firm that burned them — every failed attempt is a reason the do-it-yourself objection will not come later. And “what has it cost you?” converts three years of penalties and worry into a stated, owned loss that [[strat.cost-of-waiting]] can stand on. Go to the emotional bottom, but go with the doctor’s bedside manner ([[strat.shame-reduction]]) — the funnel exposes pain to solve it, never to twist it.",
      },
      {
        kind: "lines",
        heading: "The funnel in floor voice",
        items: [
          "“Tell me more about that — when you say it’s been hanging over you, what does that actually look like day to day?”",
          "“What have you tried so far? … And how did that go?”",
          "“Between the penalties stacking and just carrying it around — what do you figure this has cost you already, all in?”",
          "“Can I ask — how do you feel about it still being unresolved after three years?”",
        ],
      },
      {
        kind: "example",
        weak: "“So you owe about $40k for three years — okay! Well let me tell you about our resolution process and what we can do for penalties…”",
        strong: "“Forty over three years. How long since the first notice? … Two years. What have you tried in that time? … Called them once, gave up on hold. How did the not-dealing-with-it approach work out? … Right — it grew. What’s it cost you so far, between penalties and just carrying it? … And how do you feel about going into another year like this?”",
        note: "The weak version pitches at the intellectual surface — the prospect will “think about it,” because nothing hurts yet. The strong version walks the rungs in order; by the bottom, the prospect has personally stated that inaction failed, cost money, and feels bad — which is the case for the sale, in their own voice.",
      },
      {
        kind: "drill",
        prompt: "Prospect says flatly: “I owe about thirty grand, I just want to know what you charge.” They are at the top of the funnel demanding the bottom of the pitch. What’s your move?",
        answer: "Do not pitch a price to a painless prospect — a number without stakes is always “too much.” Take one step down the funnel first, honestly framed: “I’ll get you real numbers — and they depend on what we’re dealing with, so give me sixty seconds. How long has the thirty been building? … What have you tried so far? … What’s it costing you letting it ride?” Two or three rungs down, the price question becomes a value question — and you answer it into a problem they have now said out loud they want gone.",
      },
    ],
    links: ["strat.pain-funnel", "strat.cost-of-waiting", "script.discovery", "psych.cialdini.commitment", "strat.shame-reduction", "obj.early-price-probe"],
  },

  {
    id: "psych.sandler.negative-reverse",
    part: "psychology",
    section: "sandler",
    title: "Negative reverse: argue gently against yourself",
    aliases: ["negative reverse", "takeaway", "reverse selling", "maybe this isn't for you", "reactance"],
    lead: "Sandler’s counter-intuitive signature: when a prospect resists, do not push harder — step back and gently suggest maybe this ISN’T for them. A defensive prospect who feels the pressure vanish will often turn around and argue YOUR side. It only works if you are genuinely willing to walk.",
    blocks: [
      {
        kind: "prose",
        heading: "The tool, in Sandler’s terms",
        text: "Sandler observed that pressure and resistance are a matched pair: push, and the prospect pushes back, because pushing back is the buyer’s half of the dance. His reversal exploits the pairing. When resistance rises, the seller REMOVES the pressure entirely — “you know, listening to you, maybe this isn’t something you need,” or “sounds like you’ve got it handled; should we just leave it here?” — and the defensive energy, with nothing to press against, frequently swings the other way: the prospect starts explaining why they DO have a problem, why they CAN’T just handle it. Sandler called moves in this family stripping (softly restating the prospect’s pushback until they retreat from it) and taught the pendulum image: when the prospect swings negative, you do not drag them positive — you swing gently MORE negative, and they self-correct past center. The psychology underneath is reactance — the same force behind Cialdini’s scarcity: people defend a freedom that is being taken, and when you take away the OPPORTUNITY instead of their autonomy, the thing they defend becomes the deal itself. Sandler’s discipline, and it is non-negotiable: the reverse must be sincere. It is a real offer to end the conversation, delivered soft and unbothered — not a pouting bluff. Prospects detect the difference instantly, and a detected bluff is worse than a straight push.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "This is the psychology under the house [[strat.takeaway]], and our situation makes the sincerity requirement easy to meet: some people genuinely should not buy — the debt too small, the situation not ours to fix — and a rep who has internalized that walks with real calm. Use it when the prospect is arguing every point, stalling reflexively, or performing indifference (“I’m not really worried about it”). The step-back — “you might be right; if it’s really not keeping you up at night, maybe it’s not worth dealing with” — hands them the freedom their defense was fighting for, and very often they immediately reach back for the problem: “well, I mean, I can’t just IGNORE it…” The moment they argue your side, be quiet and let them ([[psych.voss.no-oriented]] runs on the same reactance current: no-shaped questions feel safe for the same reason). Boundaries: never use the takeaway on genuine fear — a scared prospect stepping toward you needs [[strat.human-reassurance]], not a step back; and never as a pressure trick with a manufactured deadline riding on it, which converts Sandler’s move into the smuggler’s scarcity.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You know what — you might be right. If it’s truly not costing you sleep, maybe this isn’t the year to deal with it. Should we leave it there?”",
          "“I don’t want to talk you into something you don’t think you need. It sounds like you feel like you’ve got it handled — do you?”",
          "“Fair enough — not everyone who owes needs a firm. Before I let you go, though: when the next notice shows up, what’s your plan?”",
        ],
      },
      {
        kind: "example",
        weak: "Prospect: “I’ll probably just deal with the IRS myself.” Agent: “That’s a huge mistake — people who go in alone get eaten alive. You really need representation, trust me.”",
        strong: "Prospect: “I’ll probably just deal with the IRS myself.” Agent: “Okay — honestly, some people do handle it themselves. Maybe you’re one of them. Just so I don’t leave you worse off: you called the number on that notice yet? … Twice, and gave up on hold. So the self-service plan — how’s it going so far?”",
        note: "The weak version pushes, so the prospect defends the DIY plan harder. The strong version agrees, steps back, and asks one calm diagnostic — and the prospect, defending nothing, hears their own answer: the plan already failed. They talk themselves toward help, which no push could have done.",
      },
      {
        kind: "drill",
        prompt: "You deliver the takeaway — “maybe this isn’t for you” — and the prospect says “yeah, you’re probably right,” and reaches for the exit. What went wrong, and what now?",
        answer: "Two possibilities, and the honest answer covers both. Either there was never enough pain — in which case the reverse did its diagnostic job and saved you both an hour; qualify once more and let them go cleanly. Or you reversed BEFORE building any pain, so they had nothing to defend — the takeaway only swings a pendulum that has weight on it. The fix is order of operations: pain funnel first ([[psych.sandler.pain-funnel]]), reverse only after they have stated what the problem is costing them. Never chase the takeaway with a panicked re-pitch — that reveals a bluff and burns the frame permanently.",
      },
    ],
    links: ["strat.takeaway", "psych.voss.no-oriented", "psych.sandler.pain-funnel", "strat.human-reassurance", "obj.diy-self-rep"],
  },

  {
    id: "psych.sandler.upfront-contract",
    part: "psychology",
    section: "sandler",
    title: "Up-front contract: agree what a decision looks like, first",
    aliases: ["upfront contract", "up-front contract", "agenda agreement", "pre-close", "no think it over"],
    lead: "Sandler’s structural tool: before the substance of the conversation, agree on its agenda and its possible endings — including that “no” is one of them. A prospect who agreed at the start that this call ends in a decision has nowhere to hide “let me think it over” at the end.",
    blocks: [
      {
        kind: "prose",
        heading: "The tool, in Sandler’s terms",
        text: "The up-front contract is Sandler’s answer to the most expensive words in sales: “let me think it over.” His insight is that the stall wins at the END of a call because nothing was agreed at the BEGINNING — the prospect never consented to deciding, so deferral is always available and always polite. The contract fixes it structurally. Before the real conversation, both sides agree on: TIME (how long we have), THEIR AGENDA and YOUR AGENDA (what each side wants covered), and above all the OUTCOME — what the possible endings of this conversation are. The Sandler move is to make “no” an explicitly welcome ending: “at the end, you might tell me this isn’t a fit — that’s completely fine, just tell me straight.” That sentence does three jobs at once. It disarms (a pusher would never authorize no); it establishes equal stature (professionals agree on agendas; supplicants just hope); and it quietly ELIMINATES the middle — by naming yes and no as the honest outcomes, “think it over” is repositioned as the one answer that breaks our agreement. When the stall comes anyway, the contract gives you a clean, non-confrontational callback: we said we’d land on a real answer — which way is it leaning?",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "The contract belongs in two places. Small version at the top of the call, right after the intro earns its seconds: a one-breath agreement on what happens next — “give me ten minutes to find out what we’re dealing with; by the end I’ll tell you exactly what we’d do and what it costs, and you can tell me yes or no — fair?” The “fair?” matters: it is a real question, and their yes is the contract (and the first micro-commitment on the [[psych.cialdini.commitment]] ladder). Big version before the pitch, at the [[script.pitch]] threshold: “I’m going to lay out exactly what we do and the fee. If it makes sense, we’ll get you set up today; if it doesn’t, tell me no — I can take it. Fair enough?” Then when [[obj.need-to-think]] surfaces anyway, you collect on the contract gently, not triumphantly: “Sure — and you said you’d shoot me straight, so help me out: is it leaning no, or is there a piece I haven’t made clear?” That is [[strat.dissolve-stall]] with the groundwork already poured; the stall dissolves because a real decision was on the docket from minute one.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Here’s what I’d suggest: ten minutes, I ask you what I need, then I tell you exactly what we’d do and exactly what it costs. At the end, yes or no — and no is fine, just say it to my face. Fair?”",
          "“Before I lay out the program — if this isn’t a fit, I want you to tell me straight. Deal?”",
          "“Earlier you said you’d give me a straight answer either way — so give it to me straight: where’s it leaning?”",
        ],
      },
      {
        kind: "drill",
        prompt: "You set the contract, delivered the pitch — and the prospect says: “Sounds good, but let me think it over.” What’s your move?",
        answer: "Collect on the agreement, warm and unbothered: “Absolutely — and hey, you promised me a straight answer, so let’s get you to one. When someone says ‘think it over,’ it’s usually one of three things: the money, the trust, or something I explained badly. Which is it for you?” The contract converts a confrontation into a callback to something THEY agreed to, and the three-way question isolates the real objection ([[strat.isolate]]) so you can answer the one thing actually in the way.",
      },
    ],
    links: ["strat.dissolve-stall", "obj.need-to-think", "strat.isolate", "psych.cialdini.commitment", "strat.next-phase-control", "script.pitch"],
  },

  // ── NEPQ ────────────────────────────────────────────────────────────────────
  {
    id: "psych.nepq",
    part: "psychology",
    section: "nepq",
    title: "NEPQ: lower the resistance, let them say the cost",
    aliases: ["nepq", "jeremy miner", "neuro emotional persuasion questions", "detached tone", "consequence questions", "what happens if you do nothing"],
    lead: "Jeremy Miner’s NEPQ — Neuro-Emotional Persuasion Questions — starts from one premise: sales pressure triggers the prospect’s threat response, so the seller’s job is to sound so calm, curious, and detached that there is nothing to resist. Its questions walk an arc from connection to consequence, and its signature addition is making the PROSPECT say the cost of doing nothing.",
    blocks: [
      {
        kind: "prose",
        heading: "The premise, in Miner’s terms",
        text: "Jeremy Miner, a former top door-to-door and insurance producer, built NEPQ around a claim about the buyer’s nervous system: the moment a prospect detects selling — the eager tone, the pitch posture, the push — their defenses come up the way they do against any perceived threat; Miner frames it in fight-or-flight terms. His prescription inverts the stereotype: the most persuasive salesperson is the LEAST pushy-sounding one. The NEPQ delivery is a calm, curious, almost puzzled “detached” tone — detached meaning unattached to the outcome, a clinician’s neutrality, not coldness — with deliberate pacing and softened phrasing (“can I ask…”, “out of curiosity…”). When the threat signal never fires, the prospect’s guard has nothing to guard against, and the questions can actually reach them. Miner’s slogan-level claim: the prospect should feel they are being UNDERSTOOD, not sold — because people are persuaded far more by what they hear themselves say than by anything the seller says.",
      },
      {
        kind: "prose",
        heading: "The question arc",
        text: "NEPQ organizes a call as a staged progression of question types. CONNECTION questions open without triggering the salesperson alarm — status and situation framed with disarming curiosity. SITUATION questions map the facts of where they are now. PROBLEM-AWARENESS questions surface what is not working and let the prospect articulate it as a problem in their own words. SOLUTION-AWARENESS questions turn them toward what fixing it would look like — what have you considered, what would it mean if this were handled. CONSEQUENCE questions — Miner’s signature — ask the cost of NOT acting: “what happens if you do nothing and this is still here a year from now?” And COMMITMENT questions convert the momentum into a next step. The structural lineage is plain and worth knowing: the situation → problem → implication → need-payoff spine is Neil Rackham’s SPIN ([[psych.spin]]), and letting the prospect state their own pain is pure Sandler ([[psych.sandler.pain-funnel]]). What NEPQ genuinely adds is the combination of the two threads: the consequence question asked in the detached tone — future-pacing the cost of inaction so gently that the PROSPECT, not the seller, ends up saying the scariest true sentence on the call. A seller who says “this will get worse” is pressure; a prospect who answers “honestly? they’d probably start garnishing me” has persuaded themselves.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text: "NEPQ’s tone thesis is already house doctrine — calm authority, never matching heat, the unhurried voice under fear ([[strat.tone]]). Where it earns its own entry is the consequence discipline. Our floor has real consequences on real paper, which makes the temptation to STATE them overwhelming — and stating them is pressure, which raises the guard NEPQ exists to keep down. The NEPQ move is to ask instead: “what do you think their next step is if this just sits?” — and let the prospect say “levy,” “garnish,” “take my refund” in their own voice. Their sentence does the work of ten of yours, it is a self-stated commitment ([[psych.cialdini.commitment]]), and it keeps your tone clean for [[strat.calm-urgency]]. The detachment also pays at the close: a rep who sounds genuinely unattached to the outcome reads as the doctor, not the pusher — and when the prospect leans in with buying-signal questions, the same calm lets you recognize the momentum and simply answer it ([[strat.buying-signals]], [[strat.answer-the-momentum]]) instead of re-pitching. And when the stall comes, a consequence question is often the cleanest solvent: “sure, take your time — while you’re thinking it over, what’s the plan if the next notice is the final one?” ([[strat.dissolve-stall]]).",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Out of curiosity — when the letters come in now, what do you do with them?”",
          "“Say you do nothing — not being harsh, genuinely asking — where do you think this is twelve months from now?”",
          "“What would it actually mean for you if the IRS was dealing with a firm instead of calling your job?”",
        ],
      },
      {
        kind: "example",
        weak: "“Sir, if you don’t act, they WILL levy your bank account and garnish your wages. It’s going to get much worse. You can’t afford to wait.”",
        strong: "“Can I ask you something straight? If this just keeps sitting the way it has been — what do you figure their next move is? … Yeah. And if that garnishment actually hit, what does that do to your month?”",
        note: "Both versions carry the same true consequence. The weak one is the seller saying it — pressure, guard up, fight-or-flight. The strong one is two calm questions, and the prospect says “garnishment” and then prices it themselves. Same facts, opposite nervous-system response — and the self-stated version binds.",
      },
      {
        kind: "drill",
        prompt: "You ask the consequence question — “what happens if you do nothing?” — and the prospect shrugs it off: “Probably nothing. They’ve been sending letters for two years and nothing’s happened.” What’s your move?",
        answer: "Stay detached — do not lunge into correction, which would hand them a pressure to resist. Get curious about their model, then add one true fact and re-ask: “Fair — two years of letters and no hammer, I get why it feels like noise. Can I ask which letter came last? … A CP504. That’s actually the one where the sequence changes — the next step after that isn’t another letter. Knowing that, same question: if it sits another six months, where does this go?” The fact is yours; the conclusion, asked again gently, still comes from them.",
      },
      {
        kind: "compliance",
        text: "Consequence questions must point at real, documented consequences — the collections ladder as it actually works — never invented threats or dates. We ask what THEY think happens; we may correct the record with true process facts; we never predict a specific IRS action on a specific date, and we never promise what a resolution will achieve.",
      },
    ],
    links: ["strat.buying-signals", "strat.dissolve-stall", "psych.spin", "psych.sandler.pain-funnel", "strat.calm-urgency", "strat.tone", "strat.answer-the-momentum"],
  },
];
