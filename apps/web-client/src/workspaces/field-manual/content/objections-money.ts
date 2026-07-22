import type { ManualEntry } from "./types";

// Money + edge objections — the part of the call where shame lives. Every
// entry here teaches the same doctrine: every play ADVANCES (toward sensitive
// info, toward agreeing to pay, or toward continued conversation), you never
// apologize for the call or for the fee, and the agent — not the prospect's
// discomfort — decides when to quit.

export const OBJECTION_MONEY_ENTRIES: ManualEntry[] = [
  // ── section: money ─────────────────────────────────────────────────────────
  {
    id: "obj.cant-afford",
    part: "objections",
    section: "money",
    title: "“I can’t afford it right now”",
    aliases: [
      "can't afford",
      "no money for this",
      "broke right now",
      "money is tight",
      "don't have the money",
      "too broke",
      "afford this right now",
    ],
    lead:
      "Usually TRUE — they owe the IRS precisely because money is tight. Treat it as a real constraint, not a negotiation tactic, and remember that shame almost always rides along with it. Your job is to keep their dignity intact while showing them that tight money is the reason to act, not the reason to wait.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This is the one money objection you should believe by default. A person with a back-tax balance is not pretending to be broke — the balance exists because money got tight somewhere along the way. That changes how you handle it: this is not a haggle, it is a person telling you something true and a little embarrassing. But “true” does not mean “disqualifying.” The first thing to sort out is whether you are hearing an objection or a condition — an objection is a request for more information (“I’m not sure this is worth it”), while a condition is a genuine inability (“there is literally no capacity”). They sound identical and they take completely different plays, so test before you play: [[strat.objection-vs-condition]]. And even a true condition still advances the call — a prospect with no capacity at all may qualify for hardship status, and finding that out requires the same financial conversation you were trying to have anyway.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Test objection vs. condition first: “Is it that the money truly isn’t there, or that you’re not sure this is worth it?” Different answers, different plays — do not skip this step.",
          "If it’s an objection, boomerang it: it is BECAUSE money is tight that the levy and garnishment exposure matters. The IRS collects from people who can least afford it — tight money is the argument FOR acting, not against it. See [[strat.boomerang]].",
          "Normalize to protect their dignity: “Most people we help are in exactly that spot — that’s why the IRS is the problem.” They expect judgment; the absence of it is what keeps them talking.",
          "Quantify inaction: penalties and interest accruing this year, levy exposure, what the balance grows to if nothing changes. The fee competes with what the IRS is already taking — that is the honest comparison.",
          "Phase the engagement: a smaller first step (the investigation phase — POA, transcripts, compliance read) instead of the full quote. Then walk the payment ladder in [[script.payment]] before you ever consider touching the number itself.",
          "If it’s a true condition — genuinely no capacity — pivot to hardship qualification. That pivot IS an advance: qualifying for hardship status requires full financial disclosure, which is exactly the conversation you wanted.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "That’s exactly why this matters — the IRS doesn’t pause while money’s tight, they garnish. The penalties this year alone are likely more than the first phase of the fee.",
          "Let’s not start with the whole thing. The first step is getting your transcripts and stopping the bleeding — that piece is a fraction of what you heard.",
          "Most of the people we help are in exactly your spot. That’s not a mark against you — it’s the whole reason this firm exists.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never fear-monger their wages — “Can you afford the IRS taking your paycheck?” as a rhetorical bludgeon reads as a threat and burns the trust you built. State the garnishment exposure as a fact once, calmly, and move on.",
          "Never frame the fee against their groceries, rent, or family budget. The fee competes with what the IRS is taking — never with what their kids eat.",
          "Never drop the price without a reason. An unexplained discount tells them the original number was inflated, and it confirms every scam fear they walked in with.",
          "Never apologize for the fee or for the call. You are not the problem on this phone call — the balance is.",
          "Never treat a true condition like a stall. If the capacity genuinely isn’t there, pushing the full quote humiliates them; the hardship pivot respects them and still advances.",
        ],
      },
      {
        kind: "example",
        weak:
          "I understand, times are tough for everybody. Well, if things change, give us a call back, okay? We’re here when you’re ready.",
        strong:
          "I hear you — and let me ask it straight: is it that the money truly isn’t there right now, or that you’re not sure this is worth it? … Okay. Then here’s the honest picture: the IRS doesn’t pause while money’s tight — the penalties this year alone are probably more than the first phase of the fee. So let’s not start with the whole thing. Step one is transcripts and stopping the bleeding, and that piece is a fraction of what you heard.",
        note:
          "The weak version accepts the objection at face value and releases the call to a maybe that never calls back. The strong version tests objection-vs-condition, boomerangs the tight money into the reason to act, and phases the engagement — three advances in four sentences, with zero shame put on the prospect.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Look, I’d love to, but I genuinely don’t have it. I’m barely covering rent.” — what’s your move?",
        answer:
          "Believe them — this sounds like a condition, not an objection. Do not push the quote. Pivot to hardship: “That actually matters here — if things are genuinely that tight, you may qualify for hardship status with the IRS, and that’s worth knowing before you pay anybody anything. Finding out takes a financial review, which is exactly what the first phase does.” The pivot preserves their dignity AND advances the call into full financial disclosure.",
      },
      {
        kind: "compliance",
        text:
          "Quantify inaction with real mechanics — penalty and interest accrual, levy exposure — never with invented deadlines or promised outcomes. You may say what WE do (pull transcripts, file representation, screen for hardship qualification); you may never say what the IRS will give them or when. And never quote a savings number or percentage to make the fee feel small.",
      },
    ],
    links: [
      "strat.objection-vs-condition",
      "strat.boomerang",
      "strat.shame-reduction",
      "strat.cost-of-waiting",
      "script.payment",
      "tax.resolution-options",
      "obj.price-too-high",
    ],
  },

  {
    id: "obj.price-too-high",
    part: "objections",
    section: "money",
    title: "“Why is it so expensive? That’s a lot of money”",
    aliases: [
      "too expensive",
      "that's a lot of money",
      "seems expensive",
      "why is it so much",
      "cheaper somewhere else",
      "cost so much",
      "price is high",
      "lot of money",
    ],
    lead:
      "This is a different animal from “I can’t afford it” — they HAVE the capacity but doubt the value. They are comparing your fee to TurboTax, a CPA’s hourly rate, or They are comparing your fee to TurboTax, a CPA’s hourly rate, or the couple-hundred-dollar do-it-yourself OIC application fee they read about online.. The answer is never to defend the number with vague value language and never to cave — it is to itemize the work and re-anchor the fee against the balance and the cost of doing nothing.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Price scrutiny is usually not rejection — it is a prospect doing the math out loud, and often it is fair scrutiny., and often it is fair scrutiny. They have no way to know what representation actually involves, so they anchor to the only numbers they’ve seen: software prices and application fees. Your job is to move the anchor. The fee should never be compared to TurboTax; it should be compared to the balance, to the penalties that accrued just this year, and to what failure on the cheap route costs. And hold this rule absolutely: never cave on price without a reason. A drop with no justification tells the prospect the original price was inflated — it converts a value question into a trust problem, which is far worse.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Itemize what the money actually buys — transcript analysis, POA filing, compliance work on unfiled returns, resolution negotiation, ongoing IRS communication, hours of licensed-rep time. Vague “we handle everything” justifies nothing; a named list of work justifies the number.",
          "Re-anchor: state the fee as a fraction of the balance and of the penalties already accrued this year. Against the debt, the fee is the only fixed number in the whole situation.",
          "Use reduction: break the fee into per-day terms against the daily cost of inaction — “this runs less per day than the interest the IRS is adding.” See [[strat.reduction]].",
          "Boomerang the size of it: it is because the number feels big that representation matters — big balances are exactly what the IRS escalates on.",
          "Differentiate the work: TurboTax files returns; it does not stand between them and a revenue officer. Name what the cheap routes don’t include and what failure there costs.",
          "Then isolate: “If the value was clear, is the number itself workable?” — that tells you whether you are still on price or have quietly moved to [[obj.cant-afford]], which is a different play. See [[strat.isolate]].",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Against a $40k balance growing at the IRS’s rates, the fee is a rounding error — and it’s the only number in this whole situation that’s fixed.",
          "TurboTax files returns. It doesn’t stand between you and a revenue officer. That’s the part you’re buying.",
          "Fair question — let me tell you exactly where it goes: transcripts, power of attorney, getting your unfiled years current, and a licensed rep negotiating your case. None of that is form-filling.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never cave on price without a reason — an unexplained drop signals the price was inflated and detonates trust.",
          "Never defend the price with vague “value” language. “You get what you pay for” convinces no one; an itemized list of the actual work does.",
          "Never apologize for the fee. State it with the same confidence you’d state the balance — see the house rule in [[script.payment]].",
          "Never frame the fee against their groceries or household budget, and never fear-monger their wages to make the number feel small. The comparison is the balance and the accrual — nothing else.",
          "Never quote a savings figure or percentage to justify the fee. The moment you promise the fee “pays for itself,” you have promised an outcome.",
        ],
      },
      {
        kind: "example",
        weak:
          "I know it seems like a lot, but honestly we’re one of the more affordable firms out there. Tell you what — let me see if I can get you a discount and knock a little off.",
        strong:
          "It’s a real number, so let me show you exactly what it buys: your transcripts pulled and analyzed, power of attorney on file so the IRS talks to us instead of you, your unfiled years brought current, and a licensed rep negotiating the balance. Against a debt that grew by thousands in penalties just this year, this fee is the only fixed number in the picture. If that value is clear — is the number itself workable, or is the real question the budget?",
        note:
          "The weak version apologizes for the fee and offers an unearned discount — which quietly confirms the price was padded. The strong version itemizes, re-anchors against the balance, and then isolates, so the agent finds out whether the objection is value or capacity before playing another card.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “A CPA would charge me half this. Why are you guys so much?” — what’s your move?",
        answer:
          "Differentiate the work, without disparaging the CPA: “A CPA preparing returns and a firm doing collections representation are different jobs under different rules. The fee isn’t for filing forms — it’s transcripts, power of attorney, compliance on the unfiled years, and a licensed rep negotiating with collections. If it were just returns, I’d tell you to use the CPA.” Then isolate: if the value landed, is the number workable? That honesty — conceding when the cheap route IS right — is what makes the rest credible.",
      },
      {
        kind: "compliance",
        text:
          "Justify the fee with the work, never with the result. You may name every action the firm takes; you may never say the fee will be recovered in savings, quote a percentage, or promise what the negotiation produces. The fee is what it costs to be represented — that statement needs no apology and no guarantee.",
      },
    ],
    links: [
      "strat.reduction",
      "strat.boomerang",
      "strat.isolate",
      "strat.confident-value-frame",
      "strat.cost-of-waiting",
      "script.payment",
      "obj.cant-afford",
    ],
  },

  {
    id: "obj.early-price-probe",
    part: "objections",
    section: "money",
    title: "“How much does it cost?” — asked before you’ve scoped anything",
    aliases: [
      "how much does it cost",
      "how much do you charge",
      "what do you charge",
      "what does this cost",
      "what's this going to cost",
      "how much is this",
      "what are your fees",
      "what would this run me",
      "how much are we talking",
    ],
    lead:
      "An early price question is usually a BUYING SIGNAL wearing an objection’s clothes — people rarely ask the price of something they don’t want. It dies two ways: dodging it (reads evasive, confirms scam fears) or quoting a number blind (anchors wrong and invites comparison shopping). The play is to answer the momentum without quoting the engagement.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "A prospect asking “how much” two minutes into the call is A prospect asking “how much” two minutes into the call is usually picturing themselves as a client — one of the most encouraging things they can say early. Treat it that way: as momentum, not as an attack on your pitch order (see [[strat.buying-signals]] and [[strat.answer-the-momentum]]). The danger is entirely in HOW you answer. Deflect with “we’ll get to that” and you sound like every evasive operation they were warned about — evasion on price undoes every trust move you have made. But quote the full engagement before you know the case and you have anchored a number to a situation you haven’t seen, invited them to shop it against firms quoting equally blind, and cheapened the diagnosis. The honest middle: give the SHAPE of the fee, and let the price question itself pull the discovery forward.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Acknowledge it as fair and serious, immediately — never “we’ll get to that.” Respecting the question is the trust move.",
          "Give the honest structure instead of a blind number: phase one (POA, transcripts, a full compliance read) is fixed and modest; the resolution phase is priced by years involved and program qualification — two things nobody knows yet.",
          "Porcupine the dependency: “The price hangs on exactly two things — how many years, and whether enforcement is active. Which are we dealing with?” The price question becomes your discovery engine. See [[strat.porcupine]].",
          "Carry the momentum into [[script.discovery]] — they told you they’re interested; go find out what the case is so the number you eventually give is real.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Fair question, and I won’t dance around it. The first phase — power of attorney, your transcripts, a full read of where you stand — is fixed and small. The fix itself gets priced off what we find, same as a contractor can’t quote a roof he hasn’t seen. So: how many years are we talking?",
          "I’ll give you a real number the minute I know two things — how many years, and whether there’s a levy in motion. Which one should we nail down first?",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never deflect with “we’ll get to that” or “don’t worry about the cost.” Evasion on price is what scammers do, and the prospect knows it.",
          "Never quote the full engagement blind. A number given before scoping anchors wrong, invites comparison shopping, and cannot be walked back.",
          "Never apologize for fees or discount unprompted — you haven’t even stated a number yet; there is nothing to soften.",
          "Never treat the question as an interruption. It is the sound of a prospect leaning in — punishing it with a canned deflection turns a buying signal into an exit.",
        ],
      },
      {
        kind: "example",
        weak:
          "Well, every case is different, so I really can’t say. Let’s not get ahead of ourselves — first tell me about your situation and we’ll talk numbers later.",
        strong:
          "Fair question, and I won’t dance around it. The first phase — power of attorney, pulling your transcripts, a full read of where you stand — is fixed and small. The resolution itself gets priced off what we find, same as a contractor can’t quote a roof he hasn’t seen. It really comes down to two things: how many years, and whether there’s enforcement in motion. So which are we dealing with?",
        note:
          "Both versions decline to quote blind — but the weak one dodges, which reads evasive, while the strong one gives the honest fee structure and converts the price question into the two discovery questions the price actually depends on. Same information withheld, opposite trust outcome.",
      },
      {
        kind: "drill",
        prompt:
          "Ninety seconds into the call, prospect says: “Before we go any further — what’s this going to cost me?” — what’s your move?",
        answer:
          "Smile — that’s a buying signal, not a wall. Acknowledge it as fair, give the shape (fixed, modest investigation phase; resolution priced off years and qualification), then porcupine: “The number hangs on how many years and whether enforcement is active — which are we dealing with?” You’ve respected the question, protected the anchor, and the prospect is now doing your discovery for you.",
      },
    ],
    links: [
      "strat.buying-signals",
      "strat.answer-the-momentum",
      "strat.porcupine",
      "script.discovery",
      "script.payment",
      "obj.price-too-high",
    ],
  },

  {
    id: "obj.contingency",
    part: "objections",
    section: "money",
    title: "“Can I pay you when the case is done?”",
    aliases: [
      "contingency",
      "pay when it's done",
      "pay you after",
      "pay out of the savings",
      "pay when you win",
      "performance based",
      "no win no fee",
      "pay at the end",
    ],
    lead:
      "They want performance-based payment — pay only if you deliver. It sounds reasonable, which is why the answer must be a clear, respectful no WITH the reason: the rules governing practice before the IRS restrict contingent fees, the labor is real regardless of outcome, and a contingency deal would require promising a result nobody honest can promise. Then offer what the house actually does: structured payment.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This prospect has been burned before, or has heard about people who were — contingency is how they try to shift the risk of another bad experience back onto you. Respect the instinct; it is a self-protection move, not an insult. But the request cannot be granted, and the worst responses are the two easy ones: caving (which you cannot do and should not pretend to consider) and dismissing it without explanation (which reads as “because we said so” and feeds the distrust that produced the request). The strong handling is the honest explanation. Tax resolution does not work on contingency for three real reasons: the ethics rules governing practitioners who represent taxpayers before the IRS restrict contingent-fee arrangements; the work — transcripts, POA, compliance filings, negotiation — happens in full whether the outcome is an offer, an installment agreement, or hardship status; and a “pay only if it works” deal quietly requires defining “works,” which drags both of you into the outcome-promising trap that [[obj.guarantee-seeking]] covers. What replaces it is structure: the payment ladder in [[script.payment]] spreads the fee without pretending the work is optional.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Validate the instinct first: “That’s a fair ask — you’re trying to protect yourself, and you should.” Agreement disarms; a flat refusal confirms their fear.",
          "Give the honest no with all three reasons: the practice rules restrict contingent fees in this work, the labor happens in full regardless of outcome, and any pay-on-results deal would require promising a result — which nobody honest in this industry does.",
          "Reframe what their protection actually is: not a contingency clause, but verifiable work — POA on file, transcripts pulled, a named case manager, actions they can see happen in the first 30 days.",
          "Offer the structure that exists instead: the payment ladder — spreading the fee is on the table; making the fee conditional is not. Then advance to [[script.payment]].",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Fair ask — and I’ll give you the straight answer: no, and here’s why. The rules for people licensed to represent you in front of the IRS restrict contingency fees in this work, and honestly, a firm offering ‘pay only if we win’ is quietly promising you a win — which nobody honest can do.",
          "The work is the same whether your case ends in an offer, a payment plan, or hardship status — transcripts, power of attorney, filings, negotiation. What I can do is structure the payments so the fee doesn’t hit at once. What I can’t do is pretend the work is free if the IRS is stubborn.",
          "Your protection isn’t a contingency clause — it’s that everything we do in the first thirty days is specific and verifiable. You’ll see each piece happen.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never cave or hint that “maybe something could be worked out” — you are negotiating against your own firm and setting up a broken promise.",
          "Never dismiss the request without the explanation. “We don’t do that” with no reason reads as arrogance to a prospect who is already suspicious.",
          "Never let the refusal drift into defining what a successful outcome would be — that is a guarantee wearing different clothes.",
          "Never apologize for the fee structure. It exists because the work is real; say that plainly.",
          "Never frame the fee against their household budget or fear-monger their wages to make structured payments feel urgent — the payment ladder sells itself when the work is itemized.",
        ],
      },
      {
        kind: "example",
        weak:
          "Hmm, we don’t normally do that… let me ask my manager if there’s anything we can do on a results basis and I’ll get back to you.",
        strong:
          "That’s a fair ask — you’re protecting yourself, and after what’s out there in this industry, you should. Straight answer: no, and for a reason that actually works in your favor. Firms offering ‘pay only if we win’ are quietly promising a win, and nobody honest can promise what the IRS decides. The work — transcripts, power of attorney, filings, negotiation — happens in full either way. What I CAN do is structure the payments. Want me to walk you through how that looks?",
        note:
          "The weak version dangles a maybe it can never deliver, guaranteeing a broken promise later. The strong version validates the instinct, gives the honest no with reasons, turns the refusal itself into a credibility play, and advances directly into the payment structure — the fee conversation continues instead of ending.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Other firms told me they only get paid out of what they save me. Why can’t you do that?” — what’s your move?",
        answer:
          "Name what that offer really is: “A fee paid out of ‘what we save you’ requires promising savings — and anyone promising savings before seeing your transcripts is lying to you. That’s the exact pitch that burns people in this industry.” Then pivot to the real protection: verifiable work in the first 30 days, and a structured payment plan on a fee that reflects real labor. You have just converted their comparison shopping into your differentiation.",
      },
      {
        kind: "compliance",
        text:
          "A contingency arrangement is an outcome promise in disguise — declining it is itself a compliance act. In explaining the no, never define or imply a target result, savings amount, or timeline. Say what the fee buys (representation and the named work), offer structured payment, and stop there.",
      },
    ],
    links: [
      "script.payment",
      "obj.guarantee-seeking",
      "tax.representation",
      "strat.earn-trust-with-proof",
      "strat.agree-first",
    ],
  },

  {
    id: "obj.guarantee-seeking",
    part: "objections",
    section: "money",
    title: "“Can you guarantee I’ll settle for pennies on the dollar?”",
    aliases: [
      "guarantee",
      "pennies on the dollar",
      "settle for less",
      "promise me",
      "how much will i save",
      "guaranteed savings",
      "wipe it out",
      "make it go away",
    ],
    lead:
      "They have absorbed the ads. A guarantee request is a TRAP — promising anything triggers compliance issues and manufactures the exact disappointment they fear. The flat, honest no is the play: “anyone who guarantees that is lying to you.” Refusing to guarantee IS the credibility move.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Years of radio ads promising “pennies on the dollar” trained this question into the market — and trained the disappointment in right behind it. When a prospect asks for a guarantee, they want one of two things: reassurance that this won’t be another burn, or a test to see whether you’ll take the bait like the last firm did. Either way, the winning answer is the same and it is counterintuitive to new agents: you say no, flatly and warmly, and the no is what wins. In an industry defined by inflated promises, the person who refuses to inflate is instantly the most credible voice they have heard. What you replace the guarantee with matters just as much: not vague hope, but the things that genuinely CAN be promised — a real licensed rep on the case, a full review of every resolution option they qualify for (see [[tax.resolution-options]]), and clear communication about what is possible based on their actual financials, read off their actual transcripts.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Name it directly and take their side against the ads: “Anyone who guarantees you a number before seeing your transcripts is lying to you — that’s the ad-speak that burned people.” You are not refusing them; you are protecting them.",
          "Replace the guarantee with what IS guaranteed: actions and posture — a licensed rep on the case, POA filed, every resolution option reviewed against their real financials, and straight answers throughout.",
          "Use qualification language for the future: “What I can tell you after we see your transcripts is which programs you actually qualify for.” Qualification is honest; prediction is not.",
          "Advance on the credibility you just banked: the transcript pull is the natural next step, because it is the only path to the real answer they were asking for.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "If someone promises you pennies on the dollar on a first phone call, hang up on them. What I’ll commit to is this: once your transcripts are in, you’ll know exactly what you qualify for — from the record, not a guess.",
          "No — and anyone who guarantees that is lying to you. Here’s what I CAN promise: a licensed rep on your case, every option on the table reviewed against your real numbers, and straight answers the whole way.",
          "I’m not going to promise you a settlement number — anyone who does on a first call is lying to you. What I can tell you is exactly what we’d do first.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never give ANY guarantee — not a number, not a percentage, not a “clients like you usually…” Anything resembling a guarantee is the ad-speak that created this question.",
          "Never say “we’ve gotten X% off for clients like you.” A savings percentage is a promise with a fig leaf on it.",
          "Never hedge into a soft yes — “we usually do very well” is a guarantee the prospect will hold you to and the firm cannot keep.",
          "Never leave a vacuum after the no. A bare refusal with nothing behind it sounds like weakness; the no must be immediately followed by what CAN be promised.",
          "Never frame the refused guarantee against their fears of wage garnishment to regain leverage — the credibility of the honest no is the leverage.",
        ],
      },
      {
        kind: "example",
        weak:
          "Well, I can’t technically guarantee anything, but between you and me, we almost always get people a big reduction. You’re in really good hands — most of our clients save a ton.",
        strong:
          "No — and honestly, anyone who guarantees that is lying to you. That ‘pennies on the dollar’ line is exactly what burned the people you’ve heard horror stories from. Here’s what I can promise, because it’s in our control: a licensed rep on your case, every resolution option reviewed against your actual financials, and straight answers the whole way. Within two weeks of pulling your transcripts, you’ll know exactly what you qualify for — not a guess, your real numbers.",
        note:
          "The weak version is a guarantee wearing a disclaimer — “I can’t technically promise, but…” is exactly what compliance forbids and exactly what disappoints later. The strong version makes the refusal itself the differentiator, then fills the space with real, keepable commitments and advances to the transcript pull.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “The last company I talked to said they could settle it for ten cents on the dollar. Can you beat that?” — what’s your move?",
        answer:
          "Do not compete with the lie — expose it, gently: “Nobody can promise you ten cents on the dollar before seeing your transcripts — the IRS decides that off your actual financials, not off a sales call. A firm that promises the outcome before seeing the file is telling you what you want to hear.” Then replace: licensed rep, full option review, qualification answer as soon as the transcripts are back. The prospect asked you to join a bidding war of promises; you win by refusing to enter it.",
      },
      {
        kind: "compliance",
        text:
          "This entry IS the compliance spine in action: never promise a result, an OIC, a dollar figure, a savings percentage, or a date. Speak only in qualification language — what programs exist, what the transcripts will show, what the firm will do. “What you qualify for, from your actual numbers” is the entire honest vocabulary of outcomes.",
      },
    ],
    links: [
      "tax.resolution-options",
      "obj.contingency",
      "obj.scam-distrust",
      "strat.earn-trust-with-proof",
      "script.pitch",
    ],
  },

  // ── section: edge ──────────────────────────────────────────────────────────
  {
    id: "obj.just-file-returns",
    part: "objections",
    section: "edge",
    title: "“I just need my back returns filed — I don’t need all this”",
    aliases: [
      "just file my returns",
      "just need to file",
      "back returns",
      "just need a preparer",
      "don't need all this",
      "only need my taxes done",
      "just the returns",
    ],
    lead:
      "They think they called a preparer. Maybe they did need one — and maybe the unfiled years are hiding a balance, an SFR, or a collections problem they haven’t seen yet. The play is a real diagnostic, then honesty: a scoped engagement for what they actually need, or a straight referral. Upselling without listening is how this one dies.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This prospect has a specific, modest ask and is bracing for you to inflate it — which means the fastest way to lose them is to launch into the full resolution pitch before you have asked a single question. But their self-diagnosis is also frequently wrong, through no fault of their own: people with unfiled years usually do not know what those years contain. If the IRS has already filed substitute returns for them ([[tax.unfiled-sfr]]), there is an assessed balance computed with the worst possible math — single, zero deductions — and “just filing” has quietly become a collections case. The honest move is a diagnostic that takes the ask seriously: how many years, any notices, any balance showing anywhere? If the answer really is “clean years, no balance, just behind on filing,” then say so and scope the engagement to exactly that — or refer them out. That honesty costs you nothing on the cases you were never going to close and builds the credibility that closes the ones where the diagnostic finds more.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Confirm what they actually need before you say one word of pitch: how many years unfiled, any IRS letters, any balance they know of, any state involvement.",
          "Explain the one thing they likely don’t know: on unfiled years the IRS eventually files FOR you — a substitute return with zero deductions and the worst math — so “just behind on filing” sometimes turns out to be “owing money you haven’t seen yet.” The transcripts settle it either way.",
          "If the diagnostic comes back clean: scope honestly. Filing the returns is a real, legitimate engagement — sell exactly that, or refer them to a preparer if the house isn’t the fit. Say so plainly.",
          "If the diagnostic finds a balance or an SFR: the case just changed, and the prospect watched it change through their own answers — no upsell required, just the facts they gave you.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Might be exactly right — let’s check it in two minutes. How many years are we talking, and have any letters shown up?",
          "Here’s the one thing worth knowing before anyone files anything: on old unfiled years, the IRS sometimes files FOR you — worst possible math, no deductions. If that happened, this stopped being a filing problem. Your transcripts show it either way.",
          "If it’s genuinely just the returns and the years come back clean, I’ll tell you that straight and we’ll scope it to just that. No reason to sell you a fix for a problem you don’t have.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never upsell without listening — pitching resolution before the diagnostic confirms there is anything to resolve is exactly what they are braced for.",
          "Never dismiss the ask as too small. “We don’t really do just returns” throws away both the small engagement and the big one hiding behind it.",
          "Never manufacture a scary story about what the unfiled years “probably” contain. Name the SFR mechanism as a real possibility to check, not a certainty to fear.",
          "Never fake the referral. If the case truly is just preparation and the house wants it, scope it; if not, point them somewhere real. A dishonest “sure, we do that” unravels at the engagement letter.",
        ],
      },
      {
        kind: "example",
        weak:
          "Well, filing returns is really just the first step — what you really need is our full resolution program, because once those returns go in, the IRS is going to come after you hard.",
        strong:
          "Might be exactly what you need — let’s confirm it in two minutes. How many years, and have any IRS letters shown up? … Okay, four years, no letters you’ve seen. One thing to check before anyone files: on years that old, the IRS sometimes files a substitute return FOR you — worst math, no deductions — and that creates a balance you haven’t seen. Your transcripts show it either way. If they come back clean, we scope this to just the returns and that’s that.",
        note:
          "The weak version confirms their fear — the inflate-the-ask upsell — and uses manufactured menace to do it. The strong version takes the ask at face value, runs a real diagnostic, teaches the one mechanism (SFR) that genuinely changes the picture, and commits out loud to honest scoping. The transcript pull advances the call in both outcomes.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I haven’t filed in five years but I don’t owe anything — I always got refunds. I just need the returns done.” — what’s your move?",
        answer:
          "Take it seriously AND test it: “If that holds, this is a filing engagement and nothing more — and there’s even a deadline issue worth knowing: refunds expire after a few years, so some of that money may already be gone. But five unfiled years is exactly the situation where the IRS files substitute returns with zero deductions, which can turn ‘they owe me’ into ‘I owe them’ on paper. Transcripts settle it in one pull. If they’re clean, we scope this to the returns — that’s a promise.” Diagnostic, honest scope, and an advance, all in one breath.",
      },
    ],
    links: [
      "tax.unfiled-sfr",
      "tax.representation",
      "script.discovery",
      "strat.takeaway",
      "strat.clarify-without-overfitting",
      "obj.too-simple",
    ],
  },

  {
    id: "obj.hopeless",
    part: "objections",
    section: "edge",
    title: "“My case is hopeless — no one can help me”",
    aliases: [
      "too far gone",
      "hopeless",
      "no one can help",
      "too complicated",
      "beyond help",
      "such a mess",
      "too late for me",
      "buried",
      "years of this",
    ],
    lead:
      "More often than not, this is not an objection — it is a confession. Years of avoidance and shame talking, from a person braced for judgment. Honor the difficulty instead of waving it away, then show them that complicated is the firm’s daily diet: complicated is not impossible, and the first step is one signature, not the whole mountain.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "When someone says “no one can help me,” they are not evaluating your services — they are telling you how long they have been carrying this and how certain they are that you will judge them for it. Despair here almost always masks shame: the unopened envelopes, the years of not filing, the mess they believe is uniquely bad. Two failure modes kill this call. The first is dismissiveness — “oh, it’s not that bad!” — which tells them you didn’t hear a word and aren’t taking the problem seriously. The second is judgment, even a whiff of it, which confirms exactly what they feared. The strong handling threads between them: honor the difficulty as real, ask for the specifics (which itself signals you aren’t scared of the answer), then normalize with concrete precedent — their “worst case ever” is a normal Tuesday intake here. Then shrink the mountain to one rock: the first step is a single signature that lets the firm see what the IRS sees. Nothing else needs deciding today. See [[strat.shame-reduction]] — the absence of judgment is most of the sale on this call.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Honor the difficulty first — “it sounds like this has been sitting on you for a long time” — before offering a single reason for hope. They need to know you heard the weight of it.",
          "Ask for the specifics: years, notices, what’s happened so far. Asking calmly signals the mess doesn’t scare you — and it converts despair into discovery.",
          "Normalize with specificity, not platitudes: “We had a client with nine unfiled years and a levy — that’s a normal intake here.” Concrete precedent beats “don’t worry” every time.",
          "Use zero judgment language about the years of avoidance. They are braced for the lecture; its absence is what builds instant trust.",
          "Distinguish complicated from impossible — complicated means more work, not no path. Then shrink to ONE step: transcripts. One signature. Not the mountain — the first rock.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "I’ve got news for you — ‘six years unfiled and scared to open the mail’ is half the people we help. You’re not the worst case I’ve heard this WEEK.",
          "Forget the whole mess for a second. Step one is one signature that lets us see what the IRS sees. That’s it. Everything else comes after.",
          "Complicated and impossible are different things. Complicated just means more work — and the work is the part we do.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never say “it’s not that bad” — dismissing the difficulty tells them you didn’t listen and don’t understand cases like theirs.",
          "Never let judgment leak — no “why did you wait so long?”, no sighing at the year count. They have already judged themselves harder than you ever could.",
          "Never pitch past the confession. Launching into the program while they are still in the shame register reads as not hearing them at all.",
          "Never promise the mess will resolve easily or fully — hope here must be honest hope: a path and a first step, not a predicted outcome.",
        ],
      },
      {
        kind: "example",
        weak:
          "Oh, don’t say that! It’s never hopeless. We help people like you all the time — let me tell you about our resolution program and everything we can do for you.",
        strong:
          "It sounds like this has been sitting on you for a long time — and honestly? ‘Years unfiled and scared to open the mail’ describes half the people we help. Tell me what’s in the pile: how many years, any levy notices? … Okay. That’s complicated — I won’t pretend otherwise — but complicated and impossible are different things. Forget the mountain for a second: step one is one signature that lets us see exactly what the IRS sees. That’s the whole decision today.",
        note:
          "The weak version waves the despair away and pivots straight to a pitch — cheerful, dismissive, and deaf. The strong version honors the weight, asks for specifics without flinching, normalizes with precedent, draws the complicated-vs-impossible line honestly, and shrinks the ask to one signature. The prospect’s shame has nowhere to attach.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “You don’t understand — I haven’t filed in eight years. There’s no fixing this. I don’t even know why I answered.” — what’s your move?",
        answer:
          "They DID answer — that is the hope talking, and your job is not to scare it off. Honor first: “Eight years is a real weight, and it sounds like you’ve been carrying it alone.” Then normalize with precedent: “It’s also, honestly, a normal intake here — we’ve handled longer.” Then shrink: “You don’t have to fix eight years today. One signature lets us see what the IRS sees, and then it’s facts instead of dread. That’s the whole first step.” Zero judgment, one rock, advance.",
      },
    ],
    links: [
      "strat.shame-reduction",
      "strat.human-reassurance",
      "psych.voss.labeling",
      "strat.channel-relief",
      "script.discovery",
      "obj.cant-afford",
    ],
  },

  {
    id: "obj.too-simple",
    part: "objections",
    section: "edge",
    title: "“My case is too simple — I don’t need a firm”",
    aliases: [
      "too simple",
      "don't need a firm",
      "i can just pay it",
      "it's not that serious",
      "small balance",
      "i'll just set up payments",
    ],
    lead:
      "Could be true — and saying so when it is happens to be your strongest play. Run a real diagnostic instead of pushing service they may not need: years, balance, enforcement. If they genuinely just need to make a payment, tell them that. Honesty on the small case is what earns the big one.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Two prospects say this sentence. One is right: a single year, a small balance, no enforcement — a case where making a payment or setting up a simple plan really is the answer. The other is minimizing: multiple years, a growing balance, a levy notice in a drawer — “simple” as a way to avoid looking at it. You cannot tell which one you have until you run the diagnostic, so run it before you take any position at all. And when the diagnostic says they are right, agree with them out loud — completely and without a pivot to a pitch. That concession is not a lost sale; it was never a sale, and conceding it honestly does two things: it makes every future word from you credible, and — per the takeaway mechanic ([[strat.takeaway]], [[psych.sandler.negative-reverse]]) — it often makes a minimizing prospect start arguing your side: “well, it’s actually three years…” Pushing service onto a genuinely simple case is the one move that loses both versions of this prospect.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Take the claim seriously and test it — a real diagnostic, not a rhetorical one: how many years? What’s the balance? Any notices, and which ones? Anything from the state?",
          "Concede the genuinely simple case honestly and specifically: “If it’s one year, a balance you can pay, and no enforcement — you might be right. You may not need anyone.” Watch what happens: minimizers start correcting you upward.",
          "If they just need to make a payment, say so — plainly, with the how: pay it or set up the simple plan directly. That honest release costs nothing real and banks credibility with everyone they talk to about taxes for the next decade.",
          "If the diagnostic surfaces complexity — multiple years, enforcement notices, an old unfiled year — name the specific fact that changed the picture, in their own words: “Three years and an LT11 isn’t the simple case — that letter has a clock on it.”",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "You might be right — and if you are, I’ll say so. Quick check: how many years, what’s the balance, and what’s the last letter that showed up?",
          "If it’s one year and a balance you can just pay — pay it. You don’t need a firm for that, and I won’t pretend you do.",
          "Here’s the thing though — you said three years and a levy notice. That’s not the simple case anymore. Simple cases don’t come with that letter.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never push service they don’t need — one inflated engagement costs the firm more in reputation than ten honest walk-aways.",
          "Never argue the case is complicated before the diagnostic proves it. Asserting complexity without facts is exactly what a suspicious prospect expects a salesman to do.",
          "Never do a fake concession — “sure, maybe, BUT let me tell you why you still need us” is a pitch wearing a concession’s coat, and they can smell it.",
          "Never let a minimizer self-diagnose unchecked either. “Too simple” with a levy notice in the drawer is denial, not simplicity — the diagnostic, not their summary, decides.",
        ],
      },
      {
        kind: "example",
        weak:
          "Well, tax cases are never as simple as people think. There’s a lot going on behind the scenes at the IRS that you can’t see, and honestly everyone needs representation these days.",
        strong:
          "You might be right — and if you are, I’ll tell you straight. Let me check three things: how many years, what’s the balance, and what was the last letter? … One year, about four grand, a CP14. Honestly? Pay it if you can, or set up the simple plan — you don’t need a firm for that, and I’m not going to sell you one. If a levy notice ever shows up or more years surface, that’s a different conversation, and now you know who to call.",
        note:
          "The weak version asserts universal complexity with zero facts — instantly recognizable as a pitch. The strong version runs the diagnostic and then does the thing almost no one on the phone ever does: tells them they’re right and lets go. That honesty is the whole play — it converts minimizers by takeaway and turns genuine simple cases into referral sources.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “It’s just one year, like $6k. I’ll set up payments myself — I don’t need to pay a firm for that.” — what’s your move?",
        answer:
          "Verify, then likely agree: “If it’s truly one year, six grand, and no enforcement letters — you’re probably right, and setting up the plan yourself is reasonable. Two things to check first so it stays simple: is that the only year, and has anything beyond a balance-due notice shown up? … If both check out, do it yourself and keep my number.” If the answers wobble — “well, there might be another year” — the takeaway just did its job, and the diagnostic continues.",
      },
    ],
    links: [
      "strat.takeaway",
      "psych.sandler.negative-reverse",
      "script.discovery",
      "obj.diy-self-rep",
      "obj.just-file-returns",
      "tax.collections-ladder",
    ],
  },

  {
    id: "obj.silence",
    part: "objections",
    section: "edge",
    title: "Silence, “mmm-hmm,” and long pauses",
    aliases: [
      "silence",
      "mmm-hmm",
      "long pause",
      "one-word answers",
      "quiet prospect",
      "stoic",
      "not saying anything",
    ],
    lead:
      "Silence is three different prospects: the stoic who processes quietly, the thinker actually working through it, and the one about to hang up. You cannot tell which from the silence itself — so get comfortable in it, ask one open question (“what’s going through your mind?”), and never, ever fill it with more pitch.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Silence isn’t spoken, which is why it’s the objection agents handle worst — there’s nothing to respond to, so the untrained instinct is to pour more words into the gap. That instinct is wrong in every one of the three cases. The stoic archetype is quiet because that is how they are on the phone; talking more just gives them more to sit through. The processor is quiet because they are actually thinking — usually about money or commitment — and interrupting the thought resets it. And the one about to hang up is looking for confirmation that this is a pressure call; an anxious babble of extra pitch is exactly that confirmation. There is also a special, load-bearing silence: the one right after a number or a stakes statement lands. That silence belongs to the prospect. Nine times out of ten, whoever fills it first gives something up — and it will not be you (see [[strat.silence-after-number]]). The universal play across all three: hold the quiet a beat longer than feels natural, then hand them one open, calibrated question and go quiet again.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Be comfortable with silence — hold it a full beat or two past your own discomfort. The pause feels three times longer to you than to them.",
          "After a number or a stakes statement lands: STOP TALKING, absolutely. That silence is theirs; whoever fills it first usually gives something up.",
          "When the silence needs breaking, break it with one open question, not a pitch: “What’s going through your mind?” — then go quiet again and let the question work. See [[psych.voss.calibrated-questions]].",
          "If you get one-word answers and “mmm-hmm,” mirror the last meaningful thing they said and wait ([[strat.mirror-to-open]]) — mirrors pull the stoic forward without pressure.",
          "Read what breaks the silence: what they say first after the pause is usually the real objection — treat it as the most honest sentence of the call.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "What’s going through your mind?",
          "Take your time — this is worth thinking about.",
          "Sounds like something in there landed. Which part are you chewing on?",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never fill silence with more pitch — every extra sentence into a quiet phone weakens the last one that landed.",
          "Never ask “are you still there?” anxiously — it broadcasts that the silence rattled you and hands control of the call to the quiet.",
          "Never re-quote or improve the number just because the pause after it got uncomfortable. A discount offered into silence is a discount nobody asked for.",
          "Never treat “mmm-hmm” as agreement and steamroll onward — minimal responses are neutral at best; check what’s underneath before building on them.",
        ],
      },
      {
        kind: "example",
        weak:
          "…so the first phase is twelve hundred. (two seconds pass) And honestly that includes a LOT — the transcripts, the power of attorney — and you know what, we do have some flexibility on that number too, so don’t let it scare you…",
        strong:
          "…so the first phase is twelve hundred. (silence — five seconds, eight seconds — the agent holds) …Prospect: “Okay. And that starts when?”",
        note:
          "In the weak version, two seconds of silence panicked the agent into re-pitching and then discounting a number the prospect never objected to — the agent negotiated against themselves into a quiet phone. In the strong version the agent simply held, and the prospect broke the silence with a buying question. The number was fine. It usually is.",
      },
      {
        kind: "drill",
        prompt:
          "You lay out the fee and the phone goes completely quiet. Five seconds. Eight. What’s your move?",
        answer:
          "Nothing. That is the move — the silence after a number belongs to the prospect, and whoever speaks first usually gives something up. Hold it. If it stretches truly long (fifteen-plus seconds) and you must break it, break it with an open question, never a concession: “What’s going through your mind?” Then be quiet again. What they say next is the real objection — handle THAT, not the silence.",
      },
    ],
    links: [
      "strat.silence-after-number",
      "psych.voss.calibrated-questions",
      "psych.voss.mirroring",
      "strat.mirror-to-open",
      "script.payment",
    ],
  },

  {
    id: "obj.no-urgency",
    part: "objections",
    section: "edge",
    title: "“The IRS hasn’t bothered me — it can wait”",
    aliases: [
      "haven't heard from them",
      "they haven't done anything",
      "haven't bothered me",
      "been sitting there for years",
      "nothing's happened",
      "no rush",
      "it can wait",
      "deal with it later",
      "haven't garnished",
      "not worried about it",
    ],
    lead:
      "The sleeping-giant case: they owe, nothing hurts yet, so the debt feels theoretical. IRS silence is processing lag, not forgiveness — and the quiet phase is the most EXPENSIVE one: maximum penalty and interest accrual, zero leverage being built. The urgency you sell must be honest — the real clock, never a manufactured one.",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "Nothing has hurt yet, so nothing feels real — that is the whole psychology. And their observation is accurate: the IRS often IS quiet for years. What they’ve misread is what the quiet means. It is not forgiveness and not forgetting; it is a slow machine accruing penalties and interest every month while it gets to their file. Enforcement then arrives in waves, triggered by data events they cannot see coming — a new employer’s W-2, a 1099 hitting the system, a refund claim, a state data share. They don’t get a friendly warning; they get the next letter up the ladder ([[tax.collections-ladder]]). Meanwhile the best outcomes in this business get negotiated BEFORE a revenue officer owns the file — waiting hands the timing to the IRS. This is [[strat.calm-urgency]] territory, and the discipline matters doubly here: the real clock is compelling enough that manufacturing pressure is not only against the rules — it is worse salesmanship. There is even an honest nuance that builds enormous credibility: for some people, waiting IS the strategy, because collection statutes expire ([[tax.csed]]). But knowing whether that applies requires the exact dates, which live on the transcripts. Either way, the next step is the same: pull them.",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Math the silence: penalties and interest since the balance year — the bill grew every quiet month. Make the growth concrete, not abstract.",
          "Name the triggers: a new employer W-2, a 1099 hitting the system, filing for a refund, state-federal data sharing — any one wakes the file. They don’t get a warning; they get a levy notice.",
          "If there are unfiled years: the IRS eventually files FOR them — a substitute return, single, zero deductions, the worst possible math ([[tax.unfiled-sfr]]). The quiet is when that clock runs.",
          "Takeaway with the honest nuance: sometimes waiting IS the strategy — collection statutes expire — but knowing whether THAT applies requires the exact CSED dates off the transcripts. Either way the next step is identical: pull them. See [[strat.takeaway]].",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Them being quiet isn’t them forgetting — it’s them adding penalties while you wait. The bill’s growing in the dark.",
          "Here’s the part nobody says out loud: the best deals get cut before a revenue officer picks up the file. Right now you have every option. After the first levy notice, you have fewer.",
          "Honestly, for some people waiting is the right move — collection windows expire. Want to know if that’s you? The expiration dates are on your transcripts. Let’s pull them and find out which case you are.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never manufacture pressure — no invented deadlines, no “they could levy you tomorrow,” no fake countdown. The real clock is honest and sufficient; a fake one destroys trust the moment they sniff it.",
          "Never fear-monger their wages or paint garnishment scenarios for effect. State the enforcement mechanics once, factually, and let the facts be heavy on their own.",
          "Never argue with their observation. They’re right that it’s been quiet — agree, then reframe what the quiet is costing them.",
          "Never hide the CSED nuance to protect the sale. Concealing the one scenario where waiting wins is exactly the omission a sophisticated prospect will later hold against the firm — and telling them is your best credibility play anyway.",
        ],
      },
      {
        kind: "example",
        weak:
          "You really don’t want to wait on this — the IRS could garnish your paycheck any day now. Seriously, people call us AFTER the levy hits and by then it’s too late. You need to act today.",
        strong:
          "You’re right, they’ve been quiet — and here’s what the quiet actually is: penalties and interest stacking every month while the file waits its turn. Enforcement kicks off on triggers you can’t see — a new W-2, a 1099, a refund claim. And honestly? For some people waiting is the RIGHT move, because collection windows expire. Whether that’s you is written on your transcripts — the balance growth, the deadlines, all of it. Let’s pull them and find out which case you are.",
        note:
          "The weak version manufactures a same-day threat (“any day now,” “too late”) — pressure that violates the honest-urgency rule and reads as exactly the scare tactic they expect. The strong version agrees with their observation, prices the quiet honestly, names the real triggers, and volunteers the CSED nuance against its own interest — which is precisely why the transcript pull lands.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “It’s been four years and they haven’t done a thing. If it mattered, they’d have called by now.” — what’s your move?",
        answer:
          "Agree with the fact, reframe the meaning: “You’re right — and that’s normal. The IRS isn’t fast; it’s patient. What those four quiet years actually did was grow the balance every single month. Enforcement starts on triggers — a new W-2, a 1099, a refund you claim — and the first thing you hear is a levy notice, not a courtesy call. One more honest thing: after enough years, some debts start expiring, and if yours is close, waiting might genuinely be your play. The dates are on your transcripts. Let’s find out which case you are.” Calm, factual, credibility-first — and the advance is the same pull either way.",
      },
      {
        kind: "compliance",
        text:
          "Honest urgency only. The situation has a real clock — accrual, the notice ladder, SFR exposure, pre-enforcement leverage — so state real mechanics and let them be heavy. Never invent a deadline, never predict when the IRS will act, never promise what acting now will produce. If you need to manufacture pressure, you haven’t learned the real facts well enough.",
      },
    ],
    links: [
      "strat.calm-urgency",
      "strat.cost-of-waiting",
      "tax.collections-ladder",
      "tax.csed",
      "tax.unfiled-sfr",
      "strat.takeaway",
    ],
  },

  {
    id: "obj.already-on-plan",
    part: "objections",
    section: "edge",
    title: "“I’m already on a payment plan with the IRS”",
    aliases: [
      "payment plan",
      "installment agreement",
      "paying them monthly",
      "already paying the irs",
      "on a plan with the irs",
      "making payments",
      "monthly payments to the irs",
      "already worked something out",
    ],
    lead:
      "They think it’s handled — that’s the trap. Most self-negotiated installment agreements are set wrong: penalties and interest keep accruing inside the plan, the payment sometimes doesn’t even cover the accrual, and nobody ever screened them for the cheaper doors. The play is a diagnostic, honestly run: is the plan actually right-sized, and what did they agree to under duress?",
    blocks: [
      {
        kind: "prose",
        heading: "What it really means",
        text:
          "This prospect did the responsible thing: they called the IRS, agreed to a number, and started paying. The problem is WHO set the number. A self-negotiated installment agreement is an agreement between a frightened taxpayer and the collection agency itself — the IRS accepts what you offer; it does not volunteer what you qualify for. So most self-set plans were agreed to under duress, sized by what the IRS asked for rather than what the taxpayer’s financials support, and set up without anyone checking the cheaper doors: first-time penalty abatement, hardship status, or an offer. Meanwhile penalties and interest keep accruing inside the plan — a payment that doesn’t outrun the accrual means the balance grows while they faithfully pay. That is a treadmill, not a resolution. And your handling must be honestly diagnostic, not reflexively critical: some plans ARE right-sized, and if theirs is, say so — that honesty is what makes the treadmill finding believable when it’s the other answer. The single question that carries the whole conversation: is the balance lower today than the day the plan started?",
      },
      {
        kind: "moves",
        heading: "The plays, in order",
        items: [
          "Run the treadmill test first: “Is the balance lower today than the day you set it up?” If it grew or barely moved, that single fact carries the whole conversation — let THEM say it out loud.",
          "Ask what they agreed to and how: did the IRS name the number, or did their financials? A payment agreed to under duress on a collection call was sized for the IRS, not for them.",
          "Abatement check: most self-set plans never pursued first-time penalty abatement — money already paid that may be recoverable. The IRS doesn’t volunteer it.",
          "Qualification check: nobody screened them for hardship status or an offer when they set it up alone — the IRS accepts what you agree to, not what you qualify for. See [[tax.resolution-options]].",
          "Default-risk frame: one missed payment can unwind the plan and restart enforcement — representation builds the version that survives a bad month.",
          "Advance: transcripts show the accrual math, the CSED dates, and what they actually qualify for. Pull them and grade the plan they’re in — and if the grade comes back “this plan is fine,” say so.",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Quick test: is the balance lower today than the day you set that plan up? If you’re not sure — that’s the answer, and it’s worth ten minutes.",
          "When you set it up yourself, did anyone check whether you qualified for hardship status or penalty abatement first? The IRS takes what you offer — they don’t mention the cheaper doors.",
          "A plan that doesn’t outrun the interest isn’t a plan, it’s rent. Let’s pull the transcripts and grade the one you’re in.",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "Never attack the plan before the diagnostic — “those plans are always wrong” is an assertion; “is the balance actually going down?” is a question they answer against themselves.",
          "Never disparage them for setting it up alone. They did the responsible thing with the information they had — the gap is what nobody told them, not what they did.",
          "Never promise the plan can be beaten — you haven’t seen the transcripts. The offer is to GRADE the plan, and an honest grade includes “yours is fine.”",
          "Never gloss the honest outcome. If their plan is right-sized, saying so plainly costs you this engagement and buys the firm the only reputation worth having.",
        ],
      },
      {
        kind: "example",
        weak:
          "Oh, those IRS payment plans are terrible — they always overcharge people. You’re definitely paying too much. We can get you a way better deal, guaranteed.",
        strong:
          "Good — you did the responsible thing. One question, though: is the balance lower today than the day you set it up? … Not sure? That’s worth ten minutes, because penalties and interest keep running inside these plans, and a payment that doesn’t outrun the accrual is rent, not progress. And when you set it up yourself — did anyone check you for penalty abatement or hardship first? The IRS takes what you offer; they don’t mention the cheaper doors. Let’s pull your transcripts and grade the plan. If it grades out fine, I’ll tell you that.",
        note:
          "The weak version asserts the plan is bad without evidence and then guarantees a better deal — two compliance violations and zero credibility. The strong version affirms their responsibility, asks the treadmill question so the doubt is self-generated, names the unchecked doors factually, and commits to an honest grade either way. The transcript pull is the advance in both worlds.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I’ve been paying $400 a month for two years. It’s handled — why would I need you?” — what’s your move?",
        answer:
          "Affirm, then run the treadmill test: “Two years of on-time payments — that’s real discipline. So here’s the ten-second test: you’ve put in about $9,600. Is the balance $9,600 lower? … If you don’t know, that’s the whole conversation — penalties and interest run inside these plans, and plenty of people pay faithfully while the balance holds still. One more thing nobody probably checked: penalty abatement, which can claw back money you already paid. Transcripts show both in one pull. If the plan grades out right-sized, I’ll say so and you keep doing exactly what you’re doing.” Their own math does the persuading.",
      },
      {
        kind: "compliance",
        text:
          "Grade, never guarantee. You may explain what self-set plans commonly miss and offer to check theirs against the transcripts; you may never promise a lower payment, recovered penalties, or a better program. “Let’s find out what you actually qualify for” is the entire honest promise — and an honest grade includes telling them their plan is fine.",
      },
    ],
    links: [
      "tax.resolution-options",
      "strat.value-audit",
      "strat.cost-of-waiting",
      "tax.csed",
      "script.discovery",
      "obj.working-with-irs",
    ],
  },
];
