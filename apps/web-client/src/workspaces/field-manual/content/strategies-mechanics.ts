import type { ManualEntry } from "./types";

// Part 3 — strategies: the classic objection mechanics (section "mechanics"),
// the discovery-to-close engines (section "funnel"), and tone (section "tone").
// Synthesized from the live coach's objection doctrine and deep-tactics bank.

export const STRATEGY_MECHANICS_ENTRIES: ManualEntry[] = [
  // ── mechanics ──────────────────────────────────────────────────────────────
  {
    id: "strat.objection-vs-condition",
    part: "strategies",
    section: "mechanics",
    title: "Objection or condition? Test before you play",
    aliases: [
      "real objection",
      "genuine inability",
      "can't vs won't",
      "smokescreen",
      "true constraint",
    ],
    lead:
      "An objection is a request for more information — the prospect is asking you to convince them. A condition is a genuine inability — no amount of persuasion changes it. Every mechanic in this manual works on objections and wastes your breath on conditions, so your first move is always to find out which one you have.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is",
        text:
          "When a prospect says “I can’t afford it,” one of two things is true. Either the money genuinely is not there — a condition — or the money could be found but they are not yet sure this is worth finding it for — an objection. These sound identical on the phone and demand opposite plays. Argue with a condition and you sound deaf and pushy. Cave to an objection and you just left a sold deal on the table. The test is one honest question, asked without judgment, that lets them tell you which case you are in.",
      },
      {
        kind: "prose",
        heading: "Why it works",
        text:
          "The question does two jobs at once. It shows respect — you are treating their stated reason as possibly true instead of steamrolling it — and it forces precision. A prospect hiding behind “can’t afford it” as a polite exit will, when asked directly, usually reveal the real hesitation: value, trust, or fear. And when it really is a condition, you still advance: on the tax-resolution floor a true hardship pivots straight into hardship and CNC qualification, which itself moves the call into full financial disclosure. Even the condition case has a next step here.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Let me ask you straight — is it that the money truly isn’t there, or that you’re not sure this is worth it? Because those are two different conversations, and I want to have the right one.”",
          "“If the money were sitting there, would we be moving today? Then it’s not about the fee — tell me what it’s really about.”",
          "“If it genuinely isn’t there right now, that actually matters — hardship status is a real thing with the IRS, and finding out whether you qualify is exactly what we’d do first.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Running boomerangs and reductions on a true condition — persuading someone with no capacity reads as predatory and burns the callback.",
          "Accepting the first “can’t afford it” at face value — most of them are objections wearing a condition’s clothes, because “no money” is the most socially acceptable exit line there is.",
          "Asking the test question with a prosecutor’s tone. It only works when it sounds like you genuinely want to know.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I just don’t have that kind of money right now.” — what’s your move?",
        answer:
          "Test before you play: “Is it that the money truly isn’t there, or that you’re not sure it’s worth it?” If it’s an objection, you now know the real target — usually value or trust — and you can isolate and answer it. If it’s a real condition, pivot to hardship/CNC qualification, which advances the call into financial disclosure anyway.",
      },
    ],
    links: ["obj.cant-afford", "obj.need-to-think", "strat.isolate", "strat.boomerang"],
  },
  {
    id: "strat.agree-first",
    part: "strategies",
    section: "mechanics",
    title: "Agree first",
    aliases: [
      "you're right to ask",
      "validate first",
      "disarm",
      "don't argue",
      "acknowledge before answering",
    ],
    lead:
      "Resistance feeds an objection; agreement starves it. “You’re right to ask that” costs you nothing, concedes nothing about your price or your process, and takes the fight out of the moment — because you can’t wrestle someone who won’t grab the rope.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is",
        text:
          "The first words out of your mouth after any objection are agreement — with the person, not necessarily with the claim. “You should be skeptical.” “That’s a fair question.” “You’re right to be careful — this industry earned it.” Only then do you answer. Notice what you are agreeing with: their right to raise it, the reasonableness of the concern, sometimes the premise itself. You are never agreeing that they should not buy.",
      },
      {
        kind: "prose",
        heading: "Why it works",
        text:
          "An objection raised is a position staked. If you push against it, the prospect defends it — and every minute spent defending it makes it more theirs. If you agree with it, there is nothing to defend, and the energy that would have gone into digging in goes into listening to what you say next. On this floor the strongest version is agreeing with the skepticism itself: a prospect braced for a pitch hears “honestly, you should be skeptical” and has to recalibrate, because scammers don’t say that. It is the accusation audit’s close cousin — say their doubt before defending against it.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Honestly? You should be skeptical — there’s been garbage in this industry. Pull up our site right now while we talk; I’ll wait.”",
          "“That’s a fair question, and I won’t dance around it.”",
          "“You’re right to be careful. So let me be specific instead of reassuring — here’s exactly what happens in the first thirty days.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "“I agree, BUT…” — the “but” erases the agreement. Use “and”: agree, then add.",
          "Agreeing and then immediately launching the same pitch you were going to give anyway. The agreement has to change what comes next, or it reads as a verbal tic.",
          "Over-agreeing into an apology for the call or the fee. You validate the concern; you never apologize for existing.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “You tax-relief companies are all crooks.” — what’s your first sentence?",
        answer:
          "Agree with the skepticism, not the verdict: “You’re right to be careful — this industry has earned that reputation.” Then separate yourself with verifiable specifics (look us up while we’re on the phone; here’s the concrete process), not reassurance. Defense would prove their point; agreement plus proof dismantles it.",
      },
    ],
    links: [
      "obj.scam-distrust",
      "obj.not-interested",
      "psych.voss.accusation-audit",
      "psych.voss.labeling",
    ],
  },
  {
    id: "strat.isolate",
    part: "strategies",
    section: "mechanics",
    title: "Isolate — then close on the condition",
    aliases: [
      "if we solved that",
      "is there anything else",
      "conditional close",
      "narrow it down",
      "smoke out the real objection",
    ],
    lead:
      "Before you answer any objection, isolate it: “if we solved that, is there anything else?” Otherwise you will spend twenty minutes answering five objections that were really one — or worse, brilliantly answering one that was never the real one. Isolation’s natural second half is the conditional close: once they agree the objection is the only thing in the way, solving it means the deal is done.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is",
        text:
          "Isolation is a question you ask before answering: “Suppose we sorted that piece out completely — is there anything else that would stop you from moving forward today?” Two outcomes, both wins. If they say “no, that’s it,” you now have one target and a de facto agreement that hitting it closes the deal. If they say “well, also…,” you just saved yourself from answering a decoy — the second objection they name is usually closer to the truth than the first.",
      },
      {
        kind: "prose",
        heading: "The conditional close",
        text:
          "The moment the prospect confirms the objection stands alone, convert it: “So if the fee piece made sense, you’d be ready to get this moving today?” That sentence transforms an objection into the terms of the sale. You are no longer selling — you are jointly solving the one named problem, with the close already agreed as the outcome. This is why you never answer an unisolated objection: answering first spends your ammunition before you know whether hitting the target wins anything.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Sure — and usually ‘think about it’ means one of two things: the fee, or whether this actually works. Which one are we really talking about?”",
          "“If the fee piece made sense, is there anything else stopping you from getting this moving today?”",
          "“If you knew they’d stalled on your file, would you want this actually moving? Then let’s pull your transcripts and see what’s really been done.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Answering the first objection you hear. Answer five in a row and you’ve run a seminar, not a close — isolate first, always.",
          "Isolating and then forgetting to convert. “Is there anything else?” — “No.” — and then more pitching. The “no” IS the opening for the conditional close; take it.",
          "Machine-gunning the isolation question after every sentence. It’s one deliberate move at the decision point, not a nervous habit.",
        ],
      },
      {
        kind: "example",
        weak:
          "“I need to think about it.” — “Sure, no problem. Well, let me also mention that we handle state balances too, and our team has decades of experience, and…”",
        strong:
          "“I need to think about it.” — “Of course. Usually when someone says that, it’s one of two things — the cost, or whether this will actually work. Which is closer? … The cost. Okay — if we sorted the cost out right now, would you be ready to get started today?”",
        note:
          "The weak version answers an objection nobody raised and buries the real one. The strong version names the likely candidates, lets the prospect pick the true target, and locks it in with the conditional close before spending a single argument on it.",
      },
      {
        kind: "drill",
        prompt:
          "You isolate — “if we solved the fee, anything else?” — and the prospect says: “Well… I’d also want to know you’re actually legit.” What just happened, and what’s your move?",
        answer:
          "The fee was a decoy; trust is the real objection — and you found out before wasting the fee conversation. Now isolate again on trust (“if you could verify us to your satisfaction, and the fee worked, we’d be moving today?”), then answer trust with verifiable specifics, not reassurance.",
      },
    ],
    links: [
      "obj.need-to-think",
      "obj.price-too-high",
      "obj.spouse-consult",
      "strat.alternative-choice",
    ],
  },
  {
    id: "strat.feel-felt-found",
    part: "strategies",
    section: "mechanics",
    title: "Feel — Felt — Found",
    aliases: [
      "i understand how you feel",
      "others felt the same",
      "here's what they found",
      "empathy bridge",
    ],
    lead:
      "For emotional objections — fear, shame, a prior burn — logic bounces off. Feel-Felt-Found is three beats that walk a prospect from their feeling to your evidence: I understand how you feel; others in your exact spot felt the same; here’s what they found.",
    blocks: [
      {
        kind: "prose",
        heading: "The three beats, and why each matters",
        text:
          "FEEL validates without arguing — you meet the emotion instead of contradicting it, which is the only entrance an emotional objection leaves open. FELT de-isolates: the person who got burned by their last tax firm believes their situation is uniquely bad and their wariness uniquely justified; learning that half your clients arrived feeling exactly this makes the feeling normal instead of disqualifying. FOUND pivots from feeling to outcome — not your claim, but the discovered experience of people just like them, which lands as social proof rather than sales talk. Skip a beat and it collapses: FOUND without FEEL is a brush-off; FEEL without FOUND is sympathy with no exit.",
      },
      {
        kind: "prose",
        heading: "When to reach for it",
        text:
          "This is the built-for-purpose tool for the burned-before prospect — someone who already paid a firm that did nothing. Their anger is at the last company, but you inherit the burden of proof. It also fits shame (“my case is hopeless”) and fear. It does NOT fit analytical objections: a prospect asking why the fee is structured this way wants an itemization, not an empathy arc.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“I get how you feel — that’s infuriating, and it’s exactly why this industry has the reputation it does. What did they actually do before things stalled?”",
          "“Half the people we help felt exactly that after their first firm. What they found was the difference is verifiable work in the first thirty days — transcripts, POA on file, a compliance read you can see happen.”",
          "“Most of our clients felt like their case was the worst one we’d ever see. What they found out is that ‘six years unfiled and scared to open the mail’ is a normal Tuesday here.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Reciting it as a formula — “I understand how you feel, others have felt the same, but they found…” in one canned breath. Deliver the beats as conversation, spaced by their responses.",
          "Saying “I understand” and moving on. The FEEL beat needs specificity — name what they’re feeling and why it’s reasonable — or it registers as a filler phrase.",
          "Making FOUND a promise of results. What others found is a process and an experience, never a guaranteed outcome — “they found the work was verifiable,” not “they found we settled it for pennies.”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I already paid another company $4,000 and they did nothing. I’m not doing that again.” — walk the three beats.",
        answer:
          "FEEL: “That’s infuriating — you did the right thing and got robbed for it.” Let them retell it; the retelling discharges the anger. FELT: “Half the people we help came to us after exactly that.” FOUND: “What they found is that real representation is verifiable in the first thirty days — POA filed, transcripts pulled, named case manager — and you’ll see each one happen.” Then offer a smaller first commitment than usual; earn the rest.",
      },
    ],
    links: ["obj.burned-before", "obj.hopeless", "obj.scam-distrust", "psych.cialdini.social-proof"],
  },
  {
    id: "strat.boomerang",
    part: "strategies",
    section: "mechanics",
    title: "The boomerang",
    aliases: [
      "that's exactly why",
      "turn the objection around",
      "the objection is the reason",
      "because money is tight",
    ],
    lead:
      "The boomerang turns the objection into the reason to act: it’s BECAUSE money is tight that the garnishment matters. The strongest objections on this floor — no money, no time, too scared — are, examined honestly, the strongest arguments for getting representation now.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is and why it works",
        text:
          "Most objections carry the seed of their own answer. “I can’t afford it” — the IRS garnishes people who can’t afford it; being broke makes enforcement more dangerous, not less relevant. “I’m too busy to deal with this” — that’s exactly why it’s been sitting for three years, and it grew the whole time. The boomerang works because it doesn’t contradict the prospect — it agrees with their fact completely and flips only the conclusion. They said something true; you show that the true thing points at action, not away from it. That’s much harder to argue with than a counter-fact, because they’d have to argue with themselves.",
      },
      {
        kind: "prose",
        heading: "The empathy prerequisite",
        text:
          "A boomerang thrown cold is a gotcha — “ha, your own words prove you wrong” — and the prospect hears cleverness, not care. Land the empathy first, especially on money: for a tax-debt prospect, “money is tight” is usually simply true, and often has shame riding along. Acknowledge the reality, keep their dignity intact, and THEN turn it: the fact stays theirs, the conclusion becomes yours, and it feels like you’re on their side of the table doing the math with them.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“That’s exactly why this matters — the IRS doesn’t pause while money’s tight, they garnish. The penalties this year alone are likely more than the first phase of the fee.”",
          "“It’s because that number feels big that representation matters — big balances are exactly what the IRS escalates on.”",
          "“You haven’t had time to deal with it — I believe you. That’s how it became four years. The clock is the whole problem, and it doesn’t care about your schedule.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Boomerang without empathy — the bare “that’s exactly why you need us!” reads as a gotcha and confirms every fear about pushy sales calls.",
          "Boomeranging a true condition. If the money genuinely is not there, this play is cruelty; test objection-vs-condition first.",
          "Using it on every objection in a row. Once per call it’s insight; three times it’s a trick they can see coming.",
        ],
      },
      {
        kind: "example",
        weak:
          "“I can’t afford it right now.” — “Well, can you really afford NOT to? Think about it!”",
        strong:
          "“I can’t afford it right now.” — “I hear you, and most people we help are in exactly that spot — that’s why the IRS is the problem. Here’s the hard part: money being tight is exactly when a garnishment hurts most, and the IRS takes from people who can least afford it. The penalties this year alone are probably more than the first phase of the fee.”",
        note:
          "The weak version is the empty slogan every prospect has heard — no empathy, no specifics, no math. The strong version validates the constraint, normalizes it, then turns their own fact into the case for acting, anchored to concrete consequences.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “They haven’t bothered me in two years — it can wait.” — boomerang it.",
        answer:
          "Their fact: the IRS has been quiet. Flip the conclusion: quiet is the most expensive phase — penalties and interest compounding every month, zero leverage being built, and the best deals get cut BEFORE a revenue officer owns the file. “Them being quiet isn’t them forgetting — it’s them adding penalties while you wait. Right now you have every option; after the first levy notice, you have fewer.”",
      },
    ],
    links: ["obj.cant-afford", "obj.no-urgency", "obj.price-too-high", "strat.cost-of-waiting"],
  },
  {
    id: "strat.porcupine",
    part: "strategies",
    section: "mechanics",
    title: "The porcupine",
    aliases: [
      "answer a question with a question",
      "toss it back",
      "keep control with a question",
      "counter-question",
    ],
    lead:
      "When a prospect tosses you a prickly question, don’t hug it — toss back a better one. The porcupine answers a question with a question, keeping control of the call and converting their curiosity into your discovery.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is",
        text:
          "Named for the obvious reason: if someone throws you a porcupine, you don’t catch it — you toss it back. On the phone, the porcupine takes a question you can’t yet answer well (“how much does it cost?” before scoping, “how fast can you stop a levy?”) and returns a question that gets you the missing information: “The price hangs on exactly two things — how many years, and whether enforcement is active. Which are we dealing with?” Whoever is asking questions is steering the call; the porcupine is how you take the wheel back without refusing to engage.",
      },
      {
        kind: "prose",
        heading: "When to reach for it — and when not to",
        text:
          "Reach for it when the honest answer genuinely depends on facts you don’t have — a blind fee quote anchors wrong and invites comparison shopping, so the price question becomes your discovery engine instead. Reach for it to test misplaced confidence: “when you call the IRS yourself, what’s your plan when they ask for a full financial disclosure on a recorded line?” Do NOT porcupine a legitimacy question. “Who are you?” and “how did you get my number?” demand direct, specific answers — dodge those and you’ve confirmed the scam suspicion. The porcupine steers momentum; it must never read as evasion.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“I’ll give you a real number the minute I know two things — how many years, and whether there’s a levy in motion. Which one should we nail down first?”",
          "“When you call them yourself, what’s your plan when they ask for a full financial disclosure on a recorded line?”",
          "“How fast? Depends what we find on the transcripts — which raises the real question: what did the last notice actually say?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Porcupining a trust or legitimacy question — those need receipts (source, date, firm name), not a counter-question.",
          "Making every answer a question. Two porcupines in a row and the prospect notices they’re being handled; answer some things plainly to keep the credit rating that makes the porcupine work.",
          "Using it as a dodge on price. The floor’s move is acknowledge-then-porcupine: call the question fair, give the honest fee structure in shape, THEN hang the precision on their facts.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect (early, before any scoping): “Just tell me — what does this cost?” — what’s your move?",
        answer:
          "Acknowledge it as fair, give the shape, then porcupine the dependency: “Fair question, and I won’t dance around it. The first phase — POA, transcripts, a full read — is fixed and small; the fix gets priced off what we find, same as a contractor can’t quote a roof he hasn’t seen. So: how many years are we talking?” The price question just became your discovery engine.",
      },
    ],
    links: [
      "obj.early-price-probe",
      "obj.diy-self-rep",
      "psych.voss.calibrated-questions",
      "strat.buying-signals",
    ],
  },
  {
    id: "strat.reduction",
    part: "strategies",
    section: "mechanics",
    title: "Reduction — break the number down",
    aliases: [
      "per day",
      "per month",
      "cost breakdown",
      "reduce to the ridiculous",
      "daily cost",
    ],
    lead:
      "Big numbers frighten; small numbers compute. Reduction breaks the fee into per-day or per-month terms and sets it against the cost of inaction — because the fee is a fixed number, and the IRS balance is the one that grows every day they wait.",
    blocks: [
      {
        kind: "prose",
        heading: "How it works",
        text:
          "A fee heard as one lump sum gets compared against rent, against savings, against fear. Broken into what it runs per day over the life of the engagement, it gets compared against coffee money — and, far more importantly on this floor, against what the IRS is adding daily in penalties and interest. That second comparison is the whole play: reduction alone shrinks your number, but reduction against the cost of inaction shows the prospect the money is already being spent — the only question is whether it buys representation or buys penalties. On a real balance, the fee is often less per day than the accrual it’s working against, and it is the only number in the entire situation that is fixed.",
      },
      {
        kind: "prose",
        heading: "When to reach for it",
        text:
          "Reduction is the natural second beat after a price objection — after you’ve agreed the question is fair and re-anchored the fee against the balance rather than against TurboTax. It pairs with the payment ladder: a fee that was impossible as a lump becomes real at two or four months, and the per-day framing makes each rung of that ladder feel proportionate to what it stops.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“This runs less per day than the interest the IRS is adding — and unlike the balance, the fee doesn’t grow.”",
          "“Against a $40k balance growing at the IRS’s rates, the fee is a rounding error — and it’s the only number in this whole situation that’s fixed.”",
          "“Break it over four months and we’re talking about a few dollars a day, working against a bill that’s compounding while we speak.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Reducing the fee against groceries or their household budget — frame it against what the IRS is taking or about to take, never against their kids’ shoes.",
          "Inventing accrual math. Use real anchors — the balance they told you, the penalty structure that actually applies — or the credibility of the whole move dies with one wrong number.",
          "Leading with reduction before value is established. A per-day price on work they don’t yet believe in is a cheap price on nothing.",
        ],
      },
    ],
    links: ["obj.price-too-high", "obj.cant-afford", "strat.cost-of-waiting", "script.payment"],
  },
  {
    id: "strat.takeaway",
    part: "strategies",
    section: "mechanics",
    title: "The takeaway (negative reverse)",
    aliases: [
      "negative reverse",
      "you might not need us",
      "maybe this isn't for you",
      "pull it back",
      "concede the simple case",
    ],
    lead:
      "Briefly and honestly agreeing that a prospect might not need help makes a defensive prospect argue your side. The takeaway works because pursuit invites retreat — and a genuine concession is the one thing no defensive prospect is braced for.",
    blocks: [
      {
        kind: "prose",
        heading: "What it is and why it works",
        text:
          "A prospect in full resistance mode has a script for everything you might say — except agreement that they might be fine without you. “If it’s one year and under ten grand, you might be right — you may not need anyone.” The pressure they were pushing against vanishes, and human nature abhors that vacuum: they start supplying the reasons themselves. “Well… it’s actually four years.” Now THEY are building your case, and a case a prospect builds is one they believe. The mechanism is simple — people resist being pushed and correct being released — but it only works when the concession is real. There genuinely are DIY-able tax cases, and saying so out loud is simultaneously honest and the most persuasive thing you can say to a skeptic.",
      },
      {
        kind: "prose",
        heading: "When to reach for it",
        text:
          "The takeaway is the tool for prospects with their heels dug in: the do-it-yourselfer, the “IRS hasn’t bothered me” sleeper, the skeptic who counters everything. It also carries the honest-nuance version of the urgency conversation: “for some people waiting IS the right move — collection windows expire. Want to know if that’s you? The dates are on your transcripts.” Either answer advances the call. Don’t use it on a prospect already leaning in — taking away from someone reaching for a yes just confuses the close.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“If this were one year and a small balance, I’d tell you to handle it yourself — honestly. Multiple years with a levy notice? That’s when people calling the IRS alone say things that cost them.”",
          "“Honestly, for some people waiting is the right move — collection windows expire. Want to know if that’s you? The expiration dates are on your transcripts. Let’s pull them and find out which case you are.”",
          "“You might not need us. There’s one honest way to know — the transcripts. If it’s simple, I’ll tell you it’s simple.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "The fake takeaway — “maybe you just can’t handle this program” as manipulation. If your concession isn’t genuinely true, the whole move is a lie and reads like one.",
          "Taking away without a path back. Every takeaway carries its own bridge — usually the transcript pull, the low-commitment diagnostic that answers the question you just raised.",
          "Overusing it into hard-to-get theatrics. It’s one clean release at the point of maximum resistance, not a personality.",
        ],
      },
      {
        kind: "example",
        weak:
          "“I’ll just call the IRS myself.” — “That’s a big mistake. You have no idea what you’re walking into. People lose everything doing that.”",
        strong:
          "“I’ll just call the IRS myself.” — “You know what — if it’s one year and under ten grand, you might be right. You may not need anyone. … How many years is it? … Four, with a levy notice? That’s the version where people on a recorded line with the IRS say things that cost them. Here’s a middle path: we pull the transcripts and tell you exactly what you’re facing. If it’s simple, you’ll know.”",
        note:
          "The weak version pushes, so the prospect pushes back and defends DIY harder. The strong version releases — an honest concession — and the prospect volunteers the four years and the levy, arguing the agent’s side. The bridge back is the diagnostic, not a pitch.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Been sitting there for years, nothing’s happened, I’m not worried about it.” — run the takeaway.",
        answer:
          "Concede the honest nuance: “For some people, waiting genuinely is the strategy — collection statutes expire.” Then hang the question they can’t answer alone: “Whether that’s you depends on the exact expiration dates, and those live on your transcripts. Let’s pull them and find out which case you are.” Either answer — waiting is right, waiting is a disaster — requires the same next step, and they just agreed to it.",
      },
    ],
    links: [
      "psych.sandler.negative-reverse",
      "obj.diy-self-rep",
      "obj.no-urgency",
      "obj.debt-expired-csed",
    ],
  },
  {
    id: "strat.alternative-choice",
    part: "strategies",
    section: "mechanics",
    title: "Alternative choice — two yeses, never a yes/no",
    aliases: [
      "tonight at 6 or tomorrow at 10",
      "either-or close",
      "choice close",
      "which works better",
    ],
    lead:
      "Never close on a question that “no” can answer. Close on a choice between two yeses — “tonight at 6 or tomorrow at 10?” — so the decision the prospect makes is which way forward, not whether to move forward at all.",
    blocks: [
      {
        kind: "prose",
        heading: "How it works",
        text:
          "A yes/no question hands the prospect a door marked EXIT and invites them to notice it. An alternative choice removes that door from the frame: both offered answers advance the call, and the prospect’s decision energy — which every human wants to spend on SOMETHING — gets spent choosing between them. It works because it’s easier to pick than to commit: “do you want to move forward?” asks them to resolve the whole decision at once, while “6 tonight or 10 tomorrow?” asks only a scheduling question, with the commitment riding quietly inside it. This is not trickery when the underlying decision has actually been earned — it’s simply not re-opening a decision by phrasing it as openable.",
      },
      {
        kind: "prose",
        heading: "Where it shows up on this floor",
        text:
          "Everywhere a next step gets set. Callbacks: “ninety seconds now, or I call you at 4:30 — your pick.” The spouse consult: “is she home now, or do we set the three of us for 6 tonight?” Payment structure: the ladder itself is an alternative choice — full fee or the two-month split — where either answer is a sold deal. Any time you hear yourself about to ask “does that work?”, replace it with two options that both work.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Ninety seconds or I call you at 4:30 — your pick.”",
          "“If she’s at work, let’s set the three of us for 6 tonight — or is tomorrow morning better for both of you?”",
          "“Some people knock this out in one payment, most split it over two months. Which is closer to comfortable for you?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Ending a close with a yes/no — “so, do you want to do this?” — after doing everything else right. It’s the most common way sold deals get un-sold.",
          "Offering a fake choice where one option is absurd (“would you rather fix this or lose your paycheck?”). Both options must be genuinely acceptable to them or it reads as a trap.",
          "Using it before the decision is earned. An alternative choice on an unconvinced prospect (“Visa or Mastercard?” two minutes in) is pushy and gets you hung up on — it seals a close, it doesn’t create one.",
        ],
      },
      {
        kind: "example",
        weak:
          "“So… would you like to schedule a follow-up call sometime?” — “Uh, maybe. Just call me whenever.”",
        strong:
          "“I’ll have your file prepped either way — do you want to do this tonight at 6 when your wife’s home, or is tomorrow at 10 better?” — “Tomorrow at 10, she’s off then.”",
        note:
          "The weak version offers a yes/no plus vagueness, and vagueness is where callbacks go to die. The strong version presumes the follow-up is happening — the file is being prepped — and spends the prospect’s decision on WHICH time, producing a specific, expected appointment.",
      },
    ],
    links: ["obj.busy-bad-time", "obj.spouse-consult", "script.close", "strat.isolate"],
  },
  {
    id: "strat.silence-after-number",
    part: "strategies",
    section: "mechanics",
    title: "Silence after the number",
    aliases: [
      "stop talking",
      "shut up after the price",
      "let it land",
      "who speaks first loses",
      "hold the pause",
    ],
    lead:
      "After a stakes statement or a number lands — the fee, the balance, the penalty math — STOP TALKING. That silence belongs to the prospect: they’re doing the only math that matters, and whoever fills the silence first gives something up.",
    blocks: [
      {
        kind: "prose",
        heading: "Why the silence works",
        text:
          "A number needs a moment to become real. When you quote the fee and keep talking, you do three destructive things at once: you signal you’re nervous about the number, you hand the prospect an escape from having to respond to it, and you often talk yourself into an unprompted discount — negotiating against yourself while the prospect just listens. When you quote it and stop, the number sits there with its full weight, the prospect processes it, and their next words tell you exactly where you stand: an objection you can now isolate, a buying question, or a yes. Silence after a stakes statement works the same way — “the penalties this year alone are more than the first phase of the fee” followed by quiet lets the comparison finish landing instead of being buried under your next sentence.",
      },
      {
        kind: "prose",
        heading: "How to hold it",
        text:
          "Deliver the number in a plain, downward-inflected sentence — no rising tone asking for approval, no “…if that’s okay” tail — and then breathe. On the phone, three seconds feels like an hour; hold it anyway. If you must do something, mute yourself. The prospect’s silence is not rejection: it’s arithmetic. Interrupting the arithmetic is the mistake.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“The first phase — power of attorney, your transcripts, the full compliance read — is $1,500.” (Then nothing. Not one more word until they speak.)",
          "“The penalties this year alone are likely more than the first phase of the fee.” (Silence — let the comparison finish landing.)",
        ],
      },
      {
        kind: "avoid",
        items: [
          "The nervous tail: “…but we can work with you on that” before they’ve said a word. That’s an unprompted discount — you just negotiated against yourself with a prospect who might have simply said yes.",
          "Re-justifying the fee into the silence. Every extra value sentence after the number tells them the number needs defending.",
          "Rising inflection on the quote — asking the price as a question invites them to answer it with a no.",
        ],
      },
      {
        kind: "example",
        weak:
          "“So the investigation phase is $1,500… which, I know, sounds like a lot, but honestly for everything you get it’s really reasonable, and if that’s tough we do have some flexibility, so…”",
        strong:
          "“The investigation phase — POA filed, transcripts pulled, full compliance read — is $1,500.” … (four seconds of silence) … “Okay. Can I split that up?” — “Absolutely. Two payments work?”",
        note:
          "The weak version buries the number under apology and discounts it before the prospect reacts at all. The strong version states it flat, holds the silence, and the prospect’s own next words move the call forward — into a payment question, which is a buying signal, not an objection.",
      },
      {
        kind: "drill",
        prompt:
          "You quote the fee. Five full seconds of dead air. Every instinct says fix it. What do you do, and why?",
        answer:
          "Nothing. Hold it. The silence is the prospect doing arithmetic, and it belongs to them — whoever fills it first gives something up. If you speak, you’ll either discount unprompted or re-open the pitch. Their next words tell you the real state of the deal: objection (isolate it), payment question (buying signal — answer and advance), or yes (stop selling, start scheduling).",
      },
    ],
    links: ["psych.voss", "obj.silence", "script.payment", "strat.tone"],
  },
  {
    id: "strat.buying-signals",
    part: "strategies",
    section: "mechanics",
    title: "Buying signals dressed as objections",
    aliases: [
      "how much does it cost",
      "how long does it take",
      "how does it work",
      "price question is interest",
      "answer the momentum",
    ],
    lead:
      "Price, timeline, and how-does-it-work questions are buying signals dressed as objections — nobody asks the cost of something they don’t want. And remember the broader read: a prospect who argues is still on the phone. Objections mean engagement; silence is the real enemy.",
    blocks: [
      {
        kind: "prose",
        heading: "The read",
        text:
          "A prospect asking “how much?” or “how long does this take?” or “what happens first?” is picturing themselves as a client — running the mental movie of being helped and checking whether the movie works. The words have an objection’s shape, so undertrained agents flinch, get defensive, or worst of all re-pitch value to someone already leaning in — which reads as not listening and can talk the lean-in right back out of them. The move is to answer the MOMENTUM, not just the words: brief, concrete, confident — steps, order, who does what — then advance to the next commitment as if working together is already the plan. Because in their head, it already is.",
      },
      {
        kind: "prose",
        heading: "The deeper read: arguing is engagement",
        text:
          "Widen the lens and the same principle covers the whole call. Every objection is a request for more information from someone still choosing to talk to you. The prospect grilling you about fees, pushing back on the timeline, arguing about whether they even need help — that person is engaged. The one to worry about is the one gone quiet, giving you polite nothing. So never resent an objection: it’s the conversation working. Treat each one as the prospect telling you exactly what stands between them and yes.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Good question — here’s the shape of it. Week one: POA on file and transcripts requested. Week two to three: we’ve got the full picture and you get the compliance read. Then we price the fix off what’s actually there. So for your file — how many years are we dealing with?”",
          "“Fair question, and I won’t dance around it. The first phase is fixed and small; the fix gets priced off what we find. How many years are we talking?”",
          "“How fast can we start? Today — it’s one signature. What’s the best email for the POA?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Re-pitching value at someone asking process questions. They’re past “why” — dragging them back to it re-opens a decision they were closing themselves.",
          "Treating an early price probe as an attack and dodging it. Evasion on price undoes every trust move made so far — acknowledge, give the honest shape, porcupine the precision.",
          "Celebrating the signal out loud (“sounds like you’re ready to move forward!”). Just answer briefly and advance; naming the lean-in makes them self-conscious about it.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Mid-call, the prospect interrupts your pitch with: “Okay, but how long does something like this actually take?” — what just happened, and what’s your move?",
        answer:
          "That’s a buying signal — they’re running the movie of being a client. Stop pitching immediately. Answer briefly and concretely (“first phase, two to three weeks to the full read; the fix depends on what the transcripts show”), then advance as if working together is the plan: “which means the sooner the POA is in, the sooner the clock starts — what’s the best email for it?”",
      },
    ],
    links: [
      "psych.nepq",
      "obj.early-price-probe",
      "obj.how-long",
      "strat.answer-the-momentum",
    ],
  },
  {
    id: "strat.commitment-language",
    part: "strategies",
    section: "mechanics",
    title: "Commitment language — hear the tense shift",
    aliases: [
      "would to will",
      "if to when",
      "stop selling start scheduling",
      "talking past the close",
      "verbal buying signs",
    ],
    lead:
      "Listen for the tense shift: “would” turning into “will,” “if” turning into “when.” When a prospect’s language moves from conditional to future, they have already decided — stop selling and start scheduling, because talking past the close is how sold deals die.",
    blocks: [
      {
        kind: "prose",
        heading: "What to listen for",
        text:
          "Early in a call, everything a prospect says is hypothetical: “what WOULD you do about the levy?”, “IF I signed up, how would that work?” Somewhere — often quietly, mid-sentence — the grammar flips: “so when you pull my transcripts, will you see the state balance too?”, “what will I need to have ready?” Nothing dramatic happened, but everything happened: in their head, the engagement is no longer a hypothesis they’re evaluating — it’s a plan they’re walking through. Ownership language is the same tell: “my case manager,” “our first step.” The prospect will almost never announce “I’ve decided.” Their verbs announce it for them.",
      },
      {
        kind: "prose",
        heading: "Why you stop selling",
        text:
          "Every value sentence delivered after the decision is made re-opens the decision. A prospect at yes who hears one more benefit doesn’t get more sold — they get reminded the choice was optional, and some fraction of them steps back through the door you just re-opened. This is the single most common way strong calls die: the agent, on a roll, keeps pitching a person who already bought. The moment the tense shifts, your job changes from persuading to organizing — next concrete step, what to have in hand, when it happens. Brief, assumptive, in motion: “perfect — here’s what happens next.”",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Prospect: “So when you guys pull the transcripts, how long till I hear back?” — Agent (selling is over): “About two weeks to the full read. Here’s what happens next: the POA goes to your email today — what’s the best address?”",
          "“Perfect — here’s the order: signature today, transcripts this week, your compliance read the week after. Only thing I need from you right now is the email for the POA.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Talking past the close — one more benefit, one more story, one more “and another thing” at a prospect whose verbs already said yes. Every extra sentence re-opens the decision.",
          "Missing the shift because you’re mid-script. The tell arrives mid-sentence and unannounced; if you’re reciting instead of listening, it sails past.",
          "Celebrating so hard it sounds like you’re surprised someone said yes. Match their energy for one beat, then get practical.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "You’re halfway through your value stack when the prospect says: “What will I need to have ready when we start?” — what do you do with the rest of your pitch?",
        answer:
          "Delete it. “Will” and “when we start” mean the decision is made — the rest of the value stack can only re-open it. Answer the logistics question, then move straight to scheduling and the POA: “Just two things — last year’s notice if you have it, and ten minutes for the intake. The POA goes to your email today; what’s the best address?”",
      },
    ],
    links: [
      "strat.take-the-yes",
      "script.close",
      "psych.cialdini.commitment",
      "strat.buying-signals",
    ],
  },

  // ── funnel ─────────────────────────────────────────────────────────────────
  {
    id: "strat.pain-funnel",
    part: "strategies",
    section: "funnel",
    title: "The pain funnel",
    aliases: [
      "tell me more",
      "how long has this been going on",
      "what have you tried",
      "what's it costing you",
      "dig into the pain",
    ],
    lead:
      "Five rungs, in order: tell me more → how long has this been going on → what have you tried → how did that work → what’s it costing you? Each question deepens the pain AND the trust — by the bottom of the funnel, the prospect has talked themselves into the seriousness of their own problem.",
    blocks: [
      {
        kind: "prose",
        heading: "The rungs, and why each one matters",
        text:
          "“Tell me more” opens the door without steering — the prospect chooses what matters, which tells you what actually matters. “How long has this been going on?” converts a snapshot into a history: a $30k balance is a fact, but “three years of certified letters I stopped opening” is a wound, and saying the duration out loud makes the prospect feel its weight, often for the first time. “What have you tried?” surfaces the failed attempts — the CPA who only files, the IRS call that went nowhere, the payment plan that never shrinks the balance — and honors their effort instead of implying helplessness. “How did that work?” makes THEM pronounce the verdict on those attempts; a failure the prospect names is believed, where the same words from you would be arguing. And “what’s it costing you?” lands the total bill — money, sleep, the marriage strain, the mail they’re afraid of — which is the number your fee will eventually be weighed against.",
      },
      {
        kind: "prose",
        heading: "Why the funnel builds trust while it digs",
        text:
          "Notice what you are NOT doing on the way down: pitching. Five rungs of genuine questions means five rungs of the prospect talking and you listening, and people trust the person who asked and listened far more than the person who explained. By the bottom, two things are simultaneously true — the problem feels as serious as it actually is, and you are the first person who took it seriously with them. That’s why the funnel comes before the pitch, always: a solution offered before the pain is felt is priced against nothing.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Walk me through it — what’s been going on with the IRS?”",
          "“How long has this been sitting on you? … Three years — and what have you tried in that time? … And how’d that go?”",
          "“So between the penalties stacking, the letters you’ve stopped opening, and not sleeping — what’s this actually costing you at this point?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Rushing the rungs — firing all five as a checklist interrogation. Each answer earns the next question; the funnel is a conversation with a direction, not a form.",
          "Skipping to the pitch the first time real pain surfaces. The rungs below the first wince are where the deal actually lives.",
          "Digging without warmth. The funnel walks someone through the worst thing in their life right now — done coldly, it’s an audit; done with genuine attention, it’s the most caring conversation they’ve had about this.",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Yeah, I owe them some money, it’s been a mess.” — name your next three questions, in order.",
        answer:
          "Rung one: “Tell me more — what kind of mess are we talking about?” Rung two: “How long has this been going on?” Rung three: “What have you tried so far?” Then let their answer to three set up “and how did that work?” — you’re walking the funnel, letting each answer earn the next question, saving “what’s it costing you?” for when the history is on the table.",
      },
    ],
    links: ["psych.sandler.pain-funnel", "psych.spin", "script.discovery", "psych.nepq"],
  },
  {
    id: "strat.cost-of-waiting",
    part: "strategies",
    section: "funnel",
    title: "The cost of waiting",
    aliases: [
      "penalties compound",
      "the clock is running",
      "cost of inaction",
      "honest urgency",
      "waiting is expensive",
    ],
    lead:
      "Quantify inaction honestly: penalties and interest compound every quiet month, notice clocks run whether or not the mail gets opened, and levies land on people who waited. The urgency is real — which is exactly why it never needs to be manufactured.",
    blocks: [
      {
        kind: "prose",
        heading: "The honest math of doing nothing",
        text:
          "A tax debt is not a static number — it is a growing one. Failure-to-pay penalties and interest accrue continuously, so every month of “dealing with it later” is a month the bill got bigger for nothing. The notice ladder runs on its own clock: a CP504 or an LT11 carries response windows, and blowing through them forfeits options that existed the day the letter arrived. Unfiled years are worse — wait long enough and the IRS files FOR you, a substitute return computed single, zero deductions, the worst possible math. And enforcement arrives in waves triggered by data events the prospect can’t see coming: a new employer’s W-2, a 1099 hitting the system, a refund claim, a state data share. Any one wakes the file. They don’t get a warning — they get a levy notice. The strategic cost is quieter but just as real: the best outcomes in this business are negotiated BEFORE a revenue officer owns the file. Right now the prospect has every option; after the first levy, they have fewer. Waiting hands the timing to the IRS.",
      },
      {
        kind: "prose",
        heading: "The honest-urgency rule",
        text:
          "The rule that governs every urgency play on this floor: the urgency must live in THEIR situation, never in your offer. No “this price expires tonight,” no invented deadlines, no theatrical panic. You don’t need any of it — the real clock is scarier than a fake one, and a fake one destroys the trust the whole call runs on. Deliver the real clock calmly: the calm is what makes it credible, because a person describing a genuine emergency doesn’t need to shout. State the math, name the triggers, and let the facts do the pressing. There is one honest nuance, and honesty demands you know it: for some prospects, waiting genuinely is the strategy, because collection statutes expire. Whether that applies is knowable only from the CSED dates on their transcripts — which makes even the exception an argument for the same next step.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Them being quiet isn’t them forgetting — it’s them adding penalties while you wait. The bill’s growing in the dark.”",
          "“Here’s the part nobody says out loud: the best deals get cut before a revenue officer picks up the file. Right now you have every option. After the first levy notice, you have fewer.”",
          "“What would you know tomorrow that you don’t know right now? That deadline on the notice doesn’t take the night off.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Manufactured pressure — expiring discounts, fake deadlines, tonight-only anything. The moment urgency lives in your offer instead of their situation, you’ve traded the truth for a tactic, and prospects can smell the trade.",
          "Alarm in your voice. Panic-selling the clock undermines it; calm urgency is the register — acknowledge the risk, confirm what’s active, move to facts.",
          "Guessing at their numbers. “Your penalties are probably $8,000 by now” invented on the spot is a promise-shaped lie; the accrual is real, so describe how it works and let the transcripts supply the figures.",
        ],
      },
      {
        kind: "compliance",
        text:
          "Honest urgency only: the pressure comes from the prospect’s real situation — accrual, notice clocks, enforcement triggers — never from manufactured scarcity or invented deadlines. And quantifying inaction is not predicting outcomes: describe what compounds and what the IRS does to people who wait, but never promise what we will stop, save, or settle, or by when.",
      },
    ],
    links: ["obj.no-urgency", "tax.collections-ladder", "tax.csed", "strat.calm-urgency", "strat.boomerang"],
  },
  {
    id: "strat.value-audit",
    part: "strategies",
    section: "funnel",
    title: "The value audit",
    aliases: [
      "itemize the work",
      "what the fee buys",
      "what did they actually do",
      "justify the fee",
      "show the work",
    ],
    lead:
      "When price is challenged, don’t defend the number — itemize the work: transcript analysis, POA filing, compliance returns, negotiation posture, licensed-rep hours. Value is shown, not asserted; a fee attached to a named list of professional work stops being a number and starts being a purchase.",
    blocks: [
      {
        kind: "prose",
        heading: "How it works",
        text:
          "“Why does it cost so much?” is almost never about the arithmetic — it’s about the invisible. The prospect is comparing your fee to the things they can see: TurboTax, a CPA’s hourly rate, the $205 DIY offer fee they read about. The audit makes the invisible visible. Phase one alone: power of attorney filed so the IRS talks to us instead of them, full transcript pull and analysis showing every balance, penalty, and deadline the way the IRS sees it, compliance returns for the unfiled years, a written read of exactly where they stand. Behind it: licensed representatives — enrolled agents and attorneys — whose hours are what the fee actually buys, plus the negotiation posture that changes how the IRS treats the file. Vague “we handle it” justifies nothing; a named list of professional work justifies itself. Then close the loop with an isolate: “if the value was clear, is the number itself workable?”",
      },
      {
        kind: "prose",
        heading: "The audit cuts both ways",
        text:
          "The same tool is your best play against an incumbent firm. When a prospect is already paying someone, don’t attack — audit: “what did you pay, and what’s the last thing they actually did on your file?” If they have to think about it, that’s the answer. Then name what those dollars should be buying anywhere — POA on file week one, transcripts pulled, a named case manager, a plan they can repeat back — as the standard, not as your pitch. The audit works in both directions because it’s the same honest question: what work, for what money? A firm doing real work survives it; a firm collecting and stalling doesn’t. Be the firm that volunteers the itemization before being asked.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“TurboTax files returns. It doesn’t stand between you and a revenue officer. That’s the part you’re buying.”",
          "“Here’s what phase one actually is: POA on file so they call us instead of you, every transcript pulled and read, the unfiled years prepped, and a written picture of exactly where you stand. Licensed people doing each piece. If that value’s clear — is the number itself workable?”",
          "“Fair question for them, not for me: what did you pay, and what’s the last thing they did on your file? If you have to think about it, that’s the answer.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Defending the number instead of itemizing the work — repeating “it’s really a fair price” is assertion; the list is the argument.",
          "Apologizing for the fee or discounting unprompted. The audit exists so you never have to do either — the fee is what professional representation costs, and the itemization shows why.",
          "Trashing the competitor by name. Audit their WORK with questions and let the prospect pronounce the verdict; attacks trigger defensiveness on the incumbent’s behalf.",
        ],
      },
      {
        kind: "compliance",
        text:
          "The audit itemizes what WE do — filings, transcripts, analysis, representation hours — never what the IRS will give. No settlement figures, no promised outcomes, no dates. And never apologize for the fee: it is the price of licensed professional work, itemized and standing on its own.",
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Four grand? A CPA would charge me a few hundred bucks.” — run the audit.",
        answer:
          "Don’t defend the number — separate the jobs, then itemize: “A CPA prepares returns — that’s a few hundred, and worth it. This is the collections side: POA so the IRS calls us instead of you, full transcript analysis, the unfiled years brought compliant, and licensed representatives negotiating the file. Different license, different work.” Then isolate: “if that value’s clear, is the number itself workable?”",
      },
    ],
    links: [
      "obj.price-too-high",
      "obj.already-have-cpa",
      "obj.hired-another-company",
      "tax.representation",
      "script.payment",
    ],
  },

  // ── tone ───────────────────────────────────────────────────────────────────
  {
    id: "strat.tone",
    part: "strategies",
    section: "tone",
    title: "Tone: calm authority, always",
    aliases: [
      "voice",
      "humor rules",
      "when to joke",
      "calm under fire",
      "downward inflection",
      "don't match their heat",
    ],
    lead:
      "Calm authority, always. No humor under enforcement, fear, distrust, fees, anger, or any do-not-call — there it reads as mockery. Light warmth only when the prospect is genuinely calm. And under fire, the voice itself is the tool: calm, slow, downward inflection — never matching their heat.",
    blocks: [
      {
        kind: "prose",
        heading: "Why calm authority is the register",
        text:
          "Every prospect on this floor is talking to a stranger about the scariest mail they get, and they are testing one thing above everything you say: is this person for real, and can they actually handle this? Calm authority answers both. Calm signals that their “worst case ever” is your normal Tuesday — panic is contagious, but so is composure. Authority signals competence without pitch: specifics delivered evenly, no rushing, no pleading. An agent who speeds up, apologizes for calling, or gets flustered under pushback tells the prospect this situation is as scary as they feared and this person can’t carry it. The register never changes with the weather of the call — that steadiness IS the message.",
      },
      {
        kind: "prose",
        heading: "The humor rules",
        text:
          "Humor is not banned — it is gated, and the gate is almost always closed. No humor when levy, garnishment, liens, frozen accounts, or wage pressure are in play: joking near enforcement reads as not grasping what’s at stake for them. None under fear or money pressure — if they’re scared or broke, cleverness sounds dismissive. None under distrust — a skeptical person reads jokes as deflection. None during fee pressure — cuteness about the price undermines the certainty they’re probing for. None at anger — humor at a hostile prospect reads as mockery and confirms their worst assumption. And a do-not-call is terminal: no humor, no charm, no one-more-thing — confirm removal immediately and end warmly. When IS it open? Only when the prospect is genuinely calm and none of those pressures are present — a dry, low-stakes softener at “I hate taxes” can make you sound alive, but it must pivot immediately to the next useful fact, and the joke is never the enforcement, the debt, or the person.",
      },
      {
        kind: "prose",
        heading: "The voice under fire",
        text:
          "When a prospect is hostile or panicking, the voice is the whole play: calm, slow, downward inflection — the late-night-DJ register. Downward inflection means sentences that end settled, not rising into a question begging for approval; it carries certainty the way rising tones carry doubt. Never match their heat: a hostile tone is a defense, not a final answer — people answering an unknown tax call are often scared or embarrassed, and heat met with heat confirms the fight they expected, while heat met with unhurried calm has nothing to push against. Don’t flinch, don’t apologize repeatedly, don’t speed up. Acknowledge once, stay flat and steady, and make one clean attempt to land the value. The same voice carries the silence plays — a pause held in a calm register is powerful; the same pause in a nervous one collapses.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "(Hostile prospect, flat and steady, no flinch:) “Understood — not trying to bother you. You did reach out about a tax issue, and that part is fixable. Do you owe the IRS, or not?”",
          "(Panicking prospect, slow, downward inflection:) “Okay. This is exactly what we do every day, so let’s take it one piece at a time. What did the last letter say at the top?”",
          "(Genuinely calm prospect grumbling “I just hate taxes”:) “You and everyone I’ve talked to today. So let’s make them someone else’s problem — which years are we looking at?”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Matching their energy — heat for heat, panic for panic, or even excitement so big it sounds like you’re surprised someone said yes.",
          "Jokes as tension relief when the tension is theirs. The pressure moments — enforcement, fees, fear, anger — are precisely where humor reads as mockery or deflection.",
          "Rising inflection on statements — turning your facts and your fee into questions invites the prospect to answer them with a no.",
          "Apologizing for the call, the fee, or the follow-up question. Warmth and respect, always; apology, never — an apologetic register concedes the scam frame before a word of content lands.",
        ],
      },
      {
        kind: "compliance",
        text:
          "An explicit do-not-call demand is terminal — a legal revocation, not a tone situation and not an objection. No mechanic in this manual applies to it: confirm removal immediately, end warmly and briefly, and honor it. The clean exit is the last brand impression we leave.",
      },
    ],
    links: [
      "strat.calm-urgency",
      "strat.hostility-resilience",
      "strat.light-warmth",
      "psych.voss.voice",
      "obj.dnc-revocation",
    ],
  },
];
