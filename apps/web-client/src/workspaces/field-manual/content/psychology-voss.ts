import type { ManualEntry } from "./types";

export const PSYCH_VOSS_ENTRIES: ManualEntry[] = [
  // ── psych.voss — tactical empathy, the umbrella ──────────────────────────
  {
    id: "psych.voss",
    part: "psychology",
    section: "voss",
    title: "Tactical empathy — Chris Voss",
    aliases: [
      "Chris Voss",
      "Never Split the Difference",
      "tactical empathy",
      "hostage negotiation",
      "FBI negotiator",
    ],
    lead:
      "Chris Voss spent 24 years as an FBI hostage negotiator and distilled the job into one idea: negotiation is driven by emotion, not logic, so the fastest way to influence someone is to understand their perspective and say it out loud. Everything else in this section is a tool for doing exactly that.",
    blocks: [
      {
        kind: "prose",
        heading: "Who taught it and what he claims",
        text:
          "Chris Voss was the FBI’s lead international kidnapping negotiator, and his book “Never Split the Difference” (2016) is the closest thing modern sales has to a field manual on high-stakes conversation. His core claim overturns the old picture of negotiation as a rational chess match: people are not rational actors who occasionally feel things — they are emotional actors who occasionally reason. Decisions get made in the feeling part of the brain and justified afterward. So the negotiator’s first job is not to argue, present, or persuade; it is to understand what the other person is feeling and wanting, and then to demonstrate that understanding by vocalizing it. Voss calls this “tactical empathy.” It is not sympathy, and it is emphatically not agreement — you can fully understand a kidnapper without approving of him. It is deliberate, applied understanding: hearing the emotion behind the words and saying it back so the other person feels heard. A person who feels heard usually calms down, talks more, and becomes open to influence. A person who feels processed tends to dig in.",
      },
      {
        kind: "prose",
        heading: "Why a hostage negotiator’s toolkit fits this floor",
        text:
          "A hostage negotiation and a tax-debt call share the same emotional weather. The person on the other end is under threat from a force they do not control, flooded with fear and shame, and deeply suspicious of the stranger on the phone. You cannot logic a flooded person — Voss learned that with barricaded gunmen, and it is just as true with a prospect holding an LT11. That is why every play in this section — mirroring, labeling, calibrated questions, the accusation audit, the pursuit of “that’s right,” no-oriented questions, and the voice itself — is a way of lowering the emotional temperature first, so the reasoning about representation and fees can actually land. Tactical empathy is the umbrella; the rest are the ribs.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "The house plays are tactical empathy wearing work clothes. [[strat.human-reassurance]] and [[strat.shame-reduction]] are vocalized understanding aimed at the two emotions that dominate these calls — fear and embarrassment. [[strat.hostility-resilience]] is the discipline of staying in tactical-empathy mode when the prospect comes in hot. The doctrine holds everywhere: the prospect’s emotions are the terrain, not the obstacle, and urgency comes from their real situation — the notice, the clock, the compounding penalties — never from pressure we manufacture. Understand first, say it out loud, and the call opens up.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Before we talk about anything else — getting letters from the IRS is genuinely scary, and most people sit on them for months because of that. You’re not behind; you’re normal.”",
          "“I’m not here to talk you into anything. I want to understand exactly where this stands for you, and then you’ll know what your options actually are.”",
          "“It sounds like this has been sitting on your shoulders a lot longer than just this phone call.”",
        ],
      },
    ],
    links: [
      "psych.voss.mirroring",
      "psych.voss.labeling",
      "psych.voss.calibrated-questions",
      "psych.voss.accusation-audit",
      "psych.voss.thats-right",
      "psych.voss.no-oriented",
      "psych.voss.voice",
      "strat.human-reassurance",
      "strat.shame-reduction",
    ],
  },

  // ── psych.voss.mirroring ─────────────────────────────────────────────────
  {
    id: "psych.voss.mirroring",
    part: "psychology",
    section: "voss",
    title: "Mirroring — repeat their last words",
    aliases: ["mirror", "mirroring", "repeat last words", "isopraxism"],
    lead:
      "Voss’s simplest tool: repeat the last one to three words the other person said, with a slight upward inflection, as a question — then be quiet. It signals “I’m with you,” and it pulls out the next layer of the story without you asking for anything.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "In “Never Split the Difference,” the mirror is the first skill Voss hands a new negotiator because it is nearly impossible to do badly. You take the last one to three words your counterpart said — or the one to three words that matter most — and repeat them back as a gentle question. “They garnished my whole check.” — “Your whole check?” Why does something that mechanical work? Voss’s answer is rooted in what biologists call isopraxism: we fear what is different and are drawn to what is similar. A mirror is a small, unmistakable signal of similarity — proof you are tracking, not waiting for your turn to talk. It invites the speaker to keep going, to elaborate, to explain — and people almost always do, usually revealing more than a direct question would have gotten. Voss adds a rule about patience: after the mirror, shut up and let it work. He tells the story of coaching a consultant through a tense exchange with her boss using nothing but a soft voice, a mirror, and silence — the whole turnaround took about thirty-one seconds. The mirror does the work only if you give it those seconds. Fill the silence and you erase it.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "The house runs this as [[strat.mirror-to-open]]: when a prospect gives you a fragment — “it’s been a mess for years,” “my ex handled the taxes,” “they took money out of my account” — mirror the loaded words and wait. It is the cheapest discovery tool on the floor: no interrogation, no form-filling feel, and the prospect narrates their own situation in their own order. It also pairs naturally with the discipline of [[strat.silence-after-number]] — in both cases, the move is to stop talking and let the other person fill the space. Mirrors earn their keep early in discovery and any time the prospect drops a phrase that clearly has a story behind it.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Prospect: “Honestly it all fell apart after the divorce.” — You: “After the divorce?” …then silence.",
          "Prospect: “I got some letter saying they’re going to levy.” — You: “Going to levy?”",
          "Prospect: “I tried calling them but it went nowhere.” — You: “Went nowhere?”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “I haven’t filed in a few years because things got complicated.” — what’s your mirror, and what do you do next?",
        answer:
          "“Things got complicated?” — with a soft upward inflection, then nothing. Do not stack a second question on top. Give the mirror its thirty seconds; the prospect will unpack “complicated” themselves — job loss, divorce, a business that folded — and that story is the discovery you needed.",
      },
    ],
    links: ["strat.mirror-to-open", "strat.silence-after-number", "psych.voss"],
  },

  // ── psych.voss.labeling ──────────────────────────────────────────────────
  {
    id: "psych.voss.labeling",
    part: "psychology",
    section: "voss",
    title: "Labeling — “it sounds like…”",
    aliases: ["label", "labeling", "it sounds like", "it seems like", "affect labeling"],
    lead:
      "Name the emotion you hear — “it sounds like…”, “it seems like…” — and the emotion loses power. Lean away from “I understand”: a label is about them; “I understand” is a claim about you, and it often invites “no, you don’t.”",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "A label is a verbal observation of the other person’s feeling: “It sounds like you’re worried this could get worse.” “It seems like you’ve been carrying this alone.” Voss insists on the exact scaffolding — “it sounds like / it seems like / it looks like” — because those openers point at the emotion, not at you. The psychology underneath is what researchers call affect labeling: Voss cites brain-imaging work (Matthew Lieberman’s lab at UCLA) showing that putting a feeling into words dampens activity in the amygdala, the brain’s alarm center, and engages the regions that govern rational thought. Naming a fear literally turns its volume down. Two rules of craft: after you label, go silent and let it sink in — a label followed by a pitch is just a segue. And never substitute “I understand.” It feels empathetic to say, but it shifts the frame onto you, it is unverifiable, and every prospect has heard it from someone who did not understand at all. The label proves understanding; “I understand” merely asserts it.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "Two of the house’s core plays are labels with a job to do. [[strat.shame-reduction]] labels the embarrassment that keeps people from talking about years of unfiled returns — “it sounds like you’ve been dreading this conversation” — and normalizes it, because a prospect who feels judged usually shuts down, and a prospect who feels seen tends to open the file drawer. [[strat.human-reassurance]] labels the fear itself when a levy notice or garnishment has them rattled. Labels earn their keep the moment emotion enters the call: hostility, dread, embarrassment, exhaustion. Label first, then proceed — an answered emotion stops blocking the conversation.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“It sounds like this letter scared you more than the ones before it.”",
          "“It seems like you’ve been dealing with this by yourself for a long time.”",
          "“It sounds like part of you has been expecting this call from somebody — just hoping it wasn’t the IRS first.”",
        ],
      },
      {
        kind: "avoid",
        heading: "What not to do",
        items: [
          "“I understand” / “I know how you feel” — unverifiable, about you, and invites “no, you don’t.”",
          "Labeling and immediately pitching. The silence after the label is where it works.",
          "Diagnosing instead of observing: “you’re clearly in denial” is an accusation, not a label. Stay with “it sounds like.”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect goes quiet, then says flatly: “I just feel stupid that I let it get this far.” — what’s your move?",
        answer:
          "Label it, and normalize it: “It sounds like you’ve been beating yourself up over this for a while — and honestly, most people we help sat on it for years for the exact same reason.” Then pause. Do not rush to “but the good news is…” — let the label land first, then move.",
      },
    ],
    links: [
      "strat.shame-reduction",
      "strat.human-reassurance",
      "psych.voss",
      "psych.voss.thats-right",
    ],
  },

  // ── psych.voss.calibrated-questions ──────────────────────────────────────
  {
    id: "psych.voss.calibrated-questions",
    part: "psychology",
    section: "voss",
    title: "Calibrated questions — “how” and “what”",
    aliases: [
      "calibrated questions",
      "how am I supposed to do that",
      "open questions",
      "how what questions",
    ],
    lead:
      "Open questions that start with “how” or “what” give the other person the feeling of control while putting your problem on their desk. Favor “how” and “what” over “why” — to most ears, “why” sounds like an accusation.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "Voss calls these “calibrated questions” because they are tuned to do two things at once. First, they hand the counterpart the illusion of control: an open “how” or “what” question feels like a request for their wisdom, not a demand, so they lean in instead of bracing. Second, they conscript the other person into solving your problem. His flagship is “How am I supposed to do that?” — the line kidnappers heard when they demanded a million dollars. It is a “no” that never says no: it rejects the demand while forcing the demander to consider your constraints, and people who are busy solving your problem are not attacking your position. The calibration matters: “can,” “is,” “does” produce one-word answers; “why” fires a defensive reflex — Voss notes that in every culture, “why did you do that?” reads as an accusation. So the whole toolkit is “how” and “what”: “What about this is important to you?” “How would you like to proceed?” “What happens if you do nothing?” Each one keeps them talking, keeps you learning, and keeps the pressure off the relationship.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "Calibrated questions run through the whole call. In discovery they open doors interrogation slams shut: “what happened in those years?” beats “why didn’t you file?” every time — same information, none of the accusation. Against stalls they are how you [[strat.dissolve-stall]] without arguing: “what would you need to see to feel good about this?” makes the prospect name the real objection instead of hiding behind “let me think about it.” And they are the polite cousin of the [[strat.porcupine]]: answer a question with a better question and control stays with you. One house-specific gem: when a prospect wants advice without representation, “how am I supposed to negotiate with the IRS on your file if we’re not authorized on your file?” lets them discover the answer — that the power of attorney comes first — themselves.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“What was going on in your life when the filings stopped?” — never “why didn’t you file?”",
          "“What happens on your end if this just sits for another six months?”",
          "“How am I supposed to get the IRS to pause collections if we’re not on file as your representative yet?”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect says: “Just tell me what to say to the IRS and I’ll call them myself.” — what’s your calibrated question?",
        answer:
          "“How are you planning to handle it when the agent asks about the unfiled years?” — or — “What happened the last time you got them on the phone?” Either one is a “how/what” question that lets the prospect run the do-it-yourself movie to its ending and discover the gap themselves, which lands far harder than you asserting it. See [[obj.diy-self-rep]] for the full handling.",
      },
    ],
    links: [
      "strat.porcupine",
      "strat.dissolve-stall",
      "obj.diy-self-rep",
      "psych.voss",
      "strat.pain-funnel",
    ],
  },

  // ── psych.voss.accusation-audit ──────────────────────────────────────────
  {
    id: "psych.voss.accusation-audit",
    part: "psychology",
    section: "voss",
    title: "The accusation audit — say it before they do",
    aliases: [
      "accusation audit",
      "preempt the objection",
      "you're probably thinking",
      "name it first",
    ],
    lead:
      "List the worst things the other side could be thinking about you — out loud, before they say them. “You’re probably thinking this is another scam call.” Named first, an accusation usually deflates; left unspoken, it tends to fester and run the call from the shadows.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "The accusation audit is Voss at his most counterintuitive: before you make your case, take inventory of every negative thing your counterpart could think or say about you, and voice the worst of them yourself. It feels like handing the other side ammunition. It is the opposite. Unspoken negatives do not stay neutral — they sit in the counterpart’s head, coloring everything you say, and the longer they go unnamed the more powerful they get. Saying them first does three things: it proves you see the situation from their side (tactical empathy in one stroke), it takes the sting out — an accusation loses most of its charge when its target says it calmly first — and it usually triggers a correction reflex, where the other person softens the very charge you just leveled at yourself: “well, I wasn’t going to put it THAT way…” The craft point Voss stresses: be fearless and go early. A half-hearted audit delivered after resistance has already surfaced is just an admission; a bold one delivered up front clears the air before the air can turn.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "Nowhere does the audit earn its keep like the top of a cold call to someone drowning in IRS mail and predatory “tax relief” robocalls. One of the strongest openers against [[obj.scam-distrust]] is to say it before they do: “you’re probably thinking this is another one of those scam tax calls — fair, you’ve probably gotten ten this month.” The prospect’s loaded defense fires at nothing, and what is left is curiosity. It works the same against the quieter suspicions: that you are reading a script, that you are going to pressure them, that you will judge the unfiled years. Audit honestly — name only charges that are plausibly in their head, and never follow the audit with the very behavior you just disclaimed. The audit buys you a hearing; the rest of the call has to deserve it.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“You’re probably thinking this is another scam call about your taxes — honestly, if I got the calls you get, I’d think the same thing.”",
          "“You might be bracing for a lecture about the years that didn’t get filed. You won’t get one from me — we see this every single day.”",
          "“You’re probably expecting me to pressure you into something before you hang up. I’m not going to do that — I’d rather you understand your situation first.”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "You’re dialing a lead who inquired three weeks ago and has been dodging calls since. What’s your accusation audit at the top of the call?",
        answer:
          "“You’re probably thinking ‘oh no, these people again’ — and that we’re going to hound you until you buy something.” Say it with a slight smile in the voice, then pause. You have named the exact thought that had their thumb hovering over the red button, and now the honest conversation — is this worth pursuing or not — can actually happen. Pairs well with a no-oriented question next: “have you given up on getting this handled?” ([[psych.voss.no-oriented]]).",
      },
    ],
    links: [
      "obj.scam-distrust",
      "obj.not-interested",
      "psych.voss.no-oriented",
      "psych.voss.labeling",
      "psych.voss",
    ],
  },

  // ── psych.voss.thats-right ───────────────────────────────────────────────
  {
    id: "psych.voss.thats-right",
    part: "psychology",
    section: "voss",
    title: "“That’s right” — not “you’re right”",
    aliases: ["that's right", "you're right", "summary", "paraphrase and label"],
    lead:
      "Voss’s breakthrough moment is when the other person says “that’s right” — the signal they feel truly understood. “You’re right” sounds similar but means the opposite: it’s what people say to make you go away. You trigger “that’s right” with a summary — paraphrase plus label.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "Voss calls “that’s right” the two most important words in negotiation, and he learned the difference the hard way — including in the negotiation with the Philippine terrorist Sabaya, which turned only after a negotiator summarized Sabaya’s entire worldview back to him and got a “that’s right” in reply. The distinction: “that’s right” is what people say when they hear their own situation, feelings, and reasoning stated better than they could state it themselves — it is the sound of feeling genuinely understood, and it changes what the person is willing to do next. “You’re right,” by contrast, is a polite push-away: it concedes your point to end the conversation, the way Voss’s own son said “you’re right, Dad” about his football technique and then changed nothing. Chasing agreement gets you “you’re right”; demonstrating understanding gets you “that’s right.” The tool that triggers it is the summary: a paraphrase of the facts as they see them, welded to a label of how those facts feel. Facts plus feeling, in their frame, until the only natural response is “that’s right.”",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "The summary belongs at the bottom of discovery, right before the pitch — it is the hinge between [[strat.pain-funnel]] and [[script.pitch]]. After the funnel has surfaced the years, the notices, the failed attempts, and the cost, wrap it in one clean summary: their story, their stakes, their feeling, in one or two sentences. A “that’s right” there means the prospect has just heard their own case for acting — made by you — and agreed with it. That can be worth more than any close. Warning read: if you are getting a lot of “you’re right, you’re right” with a flat tone, you are pushing, not understanding — stop presenting, back up, and label what you actually hear.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“So let me make sure I’ve got this. Three years unfiled, the letters kept coming, you called the IRS once and got nowhere — and now they’re touching your paycheck, and it feels like it’s moving faster than you can respond. Is that right?”",
          "“It sounds like it’s not really the money that scares you — it’s not knowing what they’ll do next.”",
          "“So the real problem isn’t that you don’t want this fixed — it’s that every road you’ve tried has dead-ended, and you’re out of ideas. Did I get that right?”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "You’ve finished discovery: single mom, two years unfiled after a layoff, a CP504 on the counter, terrified of a bank levy, tried a payment-plan call once and hung up after 40 minutes on hold. Build the summary that earns “that’s right.”",
        answer:
          "“So you lost the job, the filings slipped, and now the letters have gone from annoying to threatening — and the thing that keeps you up isn’t the balance, it’s the picture of your bank account frozen with two kids to feed. You tried doing it the right way and the IRS left you on hold for 40 minutes. That’s right where you are, isn’t it?” Paraphrase (facts, her frame) + label (the fear underneath) = summary. When she says “that’s right,” she has endorsed the case for representation herself — now the pitch is an answer, not a push.",
      },
    ],
    links: [
      "psych.voss.labeling",
      "strat.pain-funnel",
      "script.pitch",
      "strat.commitment-language",
      "psych.voss",
    ],
  },

  // ── psych.voss.no-oriented ───────────────────────────────────────────────
  {
    id: "psych.voss.no-oriented",
    part: "psychology",
    section: "voss",
    title: "No-oriented questions — let them say no",
    aliases: [
      "no-oriented questions",
      "is now a bad time",
      "start with no",
      "have you given up",
    ],
    lead:
      "Questions built to be answered “no” — “is now a bad time to talk?” — feel safe, because “no” is protection. Chasing “yes” often does the opposite: every forced little yes raises the prospect’s guard, because they can feel the trap being built.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "A generation of sales training taught the “yes ladder” — stack small yeses until the big yes feels inevitable. Voss’s field experience says the ladder is booby-trapped: people have learned what stacked yeses lead to, so every “do you want to save money on your taxes?” tightens their defenses. “Yes” is commitment, and commitment feels dangerous from a stranger. “No,” on the other hand, is safety — saying no makes people feel protected, in control, and paradoxically more willing to keep talking, because they are no longer bracing against being cornered. So Voss inverts the questions: instead of “do you have a few minutes?” ask “is now a bad time to talk?” Instead of “are you still interested?” ask “have you given up on getting this resolved?” The honest “no” that comes back — “no, now’s fine,” “no, I haven’t given up” — is the counterpart steering, and a counterpart who feels the wheel in their hands stops fighting you for it. Voss’s framing: “no” is not the end of the negotiation; it is often the start of it.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "No-oriented questions earn their keep at the two moments a tax-debt call is most fragile: the open and the re-engagement. At the open, “is now a bad time?” does the permission-asking work of [[strat.permission-legitimacy]] without begging for a yes — and it takes the air out of [[obj.busy-bad-time]] before it forms, because you offered the exit first. On a gone-cold lead, “have you given up on getting the IRS off your back?” is nearly irresistible: almost nobody wants to own “yes, I’ve given up,” so the “no” that comes back reopens the conversation with the prospect’s own commitment in it. One bright line: engineering a comfortable “no” is a technique; an explicit “stop calling” is not a “no” to work with — it is a revocation, and it is terminal.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "“Is now a bad time to talk for two minutes?”",
          "“Have you given up on getting this thing with the IRS resolved?”",
          "“Would it be crazy to spend five minutes finding out where your file actually stands?”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "A lead inquired a month ago, then went dark through six call attempts. You finally get a pickup and a wary “…hello?” — what’s your no-oriented open?",
        answer:
          "“Hi, it’s ___ with The Tax Group — you reached out about the IRS balance a while back. Have you given up on getting that handled?” The question is safe to answer, impossible to ignore, and either answer moves you forward: “no, I haven’t” reopens the file with their commitment attached; “yes, actually” is real information, and you get to ask what changed. Compare chasing “are you still interested?” — which practically begs for a brush-off yes-then-hangup.",
      },
      {
        kind: "compliance",
        text:
          "A “no” to a no-oriented question is engagement — keep working. But “stop calling me” / “take me off your list” is a do-not-call revocation, not an objection: honor it instantly and terminally. Never use question-framing to talk past a revocation.",
      },
    ],
    links: [
      "obj.busy-bad-time",
      "obj.not-interested",
      "strat.permission-legitimacy",
      "obj.dnc-revocation",
      "psych.voss",
    ],
  },

  // ── psych.voss.voice ─────────────────────────────────────────────────────
  {
    id: "psych.voss.voice",
    part: "psychology",
    section: "voss",
    title: "The late-night FM DJ voice",
    aliases: ["dj voice", "late night fm", "tone of voice", "downward inflection", "calm voice"],
    lead:
      "Voss’s default under tension: the late-night FM DJ voice — calm, slow, warm, with a downward inflection at the end of the sentence. When emotions run hot, the words barely matter; the voice is the message.",
    blocks: [
      {
        kind: "prose",
        heading: "What Voss teaches",
        text:
          "Voss teaches three voices. The playful, positive voice is the everyday default — easygoing, a smile you can hear. The direct, assertive voice is used rarely, because it almost always creates pushback. And then there is the one he made famous: the late-night FM DJ voice — deep, soft, slow, and downward-inflecting, the voice of someone utterly unhurried and utterly in control. He used it on barricaded fugitives who were deciding whether to come out or shoot, and the reason it works is neurological, not theatrical: emotional states are contagious (the mirror-neuron effect), so a calm voice literally calms the listener’s brain, the way panic in a voice spreads panic. The downward inflection matters most — ending sentences with a falling tone signals “this is settled, I’ve got this,” where a rising tone signals uncertainty and invites challenge. Voss’s rule of thumb: when the other side is hot — afraid, hostile, desperate — slow down, drop the pitch, inflect downward. In those moments, HOW you sound is doing more persuading than anything you say.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "This is the house tone doctrine, [[strat.tone]], with a byline: calm authority always, and never match their heat. A prospect screaming about the tenth tax call this week, or shaking over a levy notice, is not hearing your words yet — they are sampling your nervous system. The DJ voice is the delivery system for [[strat.hostility-resilience]]: slow, low, downward, unbothered, while the storm passes. It is also the voice for the moments that decide the deal — reading back the fee, sitting in the silence after a number ([[strat.silence-after-number]]), answering “is this going to make things worse?” A fee stated in a flat, downward, settled tone usually reads as a fact; the same fee with a rising tail reads more like an opening bid. And the house corollary Voss would endorse: no humor under enforcement, fear, distrust, or anger — warmth reads as mockery there. Save the light voice for a prospect who is genuinely at ease.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Under hostility — slower and lower, not louder: “I hear you. Take a breath — I’m not going anywhere. Tell me what the letter says.”",
          "Stating the fee, downward inflection, then silence: “The investigation and representation is $2,000. Flat.” — and stop.",
          "Under panic: “Okay. One thing at a time. Nothing is happening to your bank account tonight. Read me the notice number in the top right corner.”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect picks up mid-meltdown: “You people call me EVERY DAY, my check just got garnished, I don’t even know who you ARE—” — what does your voice do before your words do anything?",
        answer:
          "Drop the pace by half and the pitch a step; end every sentence going DOWN. “You’re right to be fed up. …I’m not one of the robocalls. …I’m calling because of the garnishment — that part I can actually do something about.” The content is an accusation audit plus a label, but the delivery is the play: your calm is the first proof you’re different from the ten calls that came before. Match their heat even a little and the call is usually over.",
      },
    ],
    links: [
      "strat.tone",
      "strat.hostility-resilience",
      "strat.silence-after-number",
      "strat.calm-urgency",
      "psych.voss",
    ],
  },

  // ── psych.spin — Rackham ─────────────────────────────────────────────────
  {
    id: "psych.spin",
    part: "psychology",
    section: "spin",
    title: "SPIN Selling — Neil Rackham",
    aliases: [
      "SPIN",
      "Neil Rackham",
      "situation problem implication need-payoff",
      "SPIN selling",
      "discovery questions",
    ],
    lead:
      "Neil Rackham’s research team analyzed 35,000 sales calls and found that big-ticket sales are won in discovery, not the close — and that classic closing techniques actually HURT large sales. His SPIN sequence (Situation → Problem → Implication → Need-payoff) is the question engine underneath our pain funnel.",
    blocks: [
      {
        kind: "prose",
        heading: "What Rackham found",
        text:
          "“SPIN Selling” (1988) is not a guru’s opinion — it is the write-up of a twelve-year research program at Huthwaite in which Rackham’s team observed and coded some 35,000 real sales calls to find out what top performers in large sales actually do. The headline finding upended the trade: the techniques that win small sales — assumptive closes, alternative closes, pressure at the end — correlate NEGATIVELY with success in large, high-stakes sales. When the decision is big, closing pressure lowers your odds, because a big decision pushed feels unsafe. What the winners did instead was ask better questions, in a recognizable arc. Situation questions gather facts and context — necessary, but boring for the buyer, so the skilled ones use them sparingly. Problem questions surface difficulties and dissatisfactions — “what’s the hardest part of that?” Implication questions, the hinge skill that most separated experts from average sellers, grow an admitted problem into its real size by exploring consequences — “what happens to X if this continues?” And Need-payoff questions invite the buyer to state the value of solving it — “what would it mean to you if this were handled?” The genius of the sequence is who ends up making the case: by the end, the BUYER has articulated the problem, its cost, and the value of the fix, in their own words. Rackham’s terms for the transformation: implied needs (“this is annoying”) get developed into explicit needs (“I need this solved”), and explicit needs stated by the buyer are what large sales are made of.",
      },
      {
        kind: "prose",
        heading: "On our floor",
        text:
          "A tax-resolution sale is a textbook Rackham “large sale”: a scary decision, real money, an anxious buyer — exactly the arena where discovery wins and closing pressure loses. The mapping is direct. Situation: the shape of the file — which years are unfiled, what notices have arrived, W-2 or 1099, roughly what is owed. Ask enough to work with, not so much it feels like an intake form. Problem: where it hurts — the garnishment, the frozen refund, the letters they have stopped opening, the failed calls to the IRS. Implication: the consequence questions that let the collections ladder do the talking — “what happens to the household budget if the levy hits your payroll?”, “where does the balance go while penalties and interest keep running?” ([[tax.collections-ladder]] and [[strat.cost-of-waiting]] live here). Need-payoff: “what would it change for you to have a licensed team standing between you and the IRS?” — the prospect states the value of representation themselves. And here is the family resemblance to see plainly: the house [[strat.pain-funnel]] — tell me more → how long → what have you tried → how did that work → what’s it costing you — is SPIN’s Problem-to-Implication chain wearing floor clothes, with need-payoff waiting at the bottom. When you run the funnel in [[script.discovery]], you are running thirty-five thousand calls’ worth of evidence.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor’s voice",
        items: [
          "Problem → Implication: “So the letters have been coming for a year. What happens on your end when this moves from letters to a levy — who feels that first?”",
          "Implication: “While this sits, penalties and interest are compounding on the balance. Where does that number end up by next year if nothing changes?”",
          "Need-payoff: “If a licensed team took over every contact with the IRS starting this week — the calls, the notices, the negotiating — what would that actually take off your plate?”",
        ],
      },
      {
        kind: "drill",
        prompt:
          "Prospect admits: “Yeah, I got a garnishment notice for my wages last week.” You are at the Problem stage. Build the Implication and Need-payoff questions that develop it — without pitching.",
        answer:
          "Implication: “What does your take-home look like if they start pulling from every check — can the mortgage survive that?” Then: “And while that’s happening, what’s the balance doing with penalties still running?” Let the answers land — the prospect is now describing the real size of the problem in their own words. Need-payoff: “If we were on file as your representative and dealing with the IRS directly about that garnishment — what would that mean for your next paycheck, and for your stress level?” Only after THEY state the value do you present. Rackham’s data says a close pushed before this point costs you the deal; the summary-and-“that’s right” move ([[psych.voss.thats-right]]) is the natural bridge from here to the pitch.",
      },
      {
        kind: "compliance",
        text:
          "Implication questions amplify consequences — so they must amplify REAL ones. Stay on the actual collections ladder and the prospect’s actual notices; never invent deadlines, inflate threats, or promise what the IRS will do or when. Say what WE do — file representation, work the file, request holds — not what the IRS will give. Urgency comes from their situation; we never manufacture it.",
      },
    ],
    links: [
      "strat.pain-funnel",
      "script.discovery",
      "strat.cost-of-waiting",
      "tax.collections-ladder",
      "psych.voss.thats-right",
      "psych.voss.calibrated-questions",
    ],
  },
];
