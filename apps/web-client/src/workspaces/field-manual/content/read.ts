import type { ManualEntry } from "./types";

// Part 1, Section 0 — Read the person first. The legitimacy read that runs
// BEFORE any selling doctrine applies. Two jobs at once: it is the trust-first
// sequencer for real prospects and the bad-actor filter for the callers who
// would turn a recorded promise into a complaint. Information is earned:
// resistance means you slow down and disclose less, not push harder.
export const READ_ENTRIES: ManualEntry[] = [
  {
    id: "read.legitimacy",
    part: "script",
    section: "read",
    title: "Read the person first — is this a real prospect?",
    aliases: [
      "legitimacy read",
      "is this person real",
      "who am I talking to",
      "vet the caller",
      "qualify the person",
      "resistant prospect",
      "guarded caller",
      "don't lead with your chin",
    ],
    lead: "Before you sell anything, read the person. A real prospect gives you their name and the details you ask for, engages their own problem, and is willing to hear you out as someone offering a consultative service. A caller who withholds all of that, deflects your questions, and fixates only on who you are is telling you something — slow down. You are not required to disclose more to someone who has not yet dropped their guard.",
    blocks: [
      {
        kind: "prose",
        heading: "Why this is the first thing in the guide",
        text: "Everything else in this manual assumes you are talking to a genuine person with a genuine tax problem who is deciding whether to trust you. That assumption has to be earned, not made. Most callers are exactly who they seem. A few are not — and the cost of misreading the few is not a lost sale, it is a headache you did not need: a fraudulent complaint, a recorded promise quoted out of context, a call engineered to make the firm look bad. The good news is that the same read protects you from both mistakes. Reading the person well is how you build trust with the real prospect and how you stay measured with the one who is fishing.",
      },
      {
        kind: "moves",
        heading: "The three checks — run them quietly, in the background",
        items: [
          "Are they giving you what you ask for? Their name, the notice, the year, the basics of their situation. A real prospect with a real problem answers these because they want help. Persistent refusal to give any identifying detail while still staying on the line is a flag.",
          "Are they engaging their own problem? When you ask about their situation, do they talk about their taxes — or do they only interrogate you? Someone genuinely worried about a levy wants to talk about the levy. Someone who steers every answer back to you may not be here for help.",
          "Are they willing to listen? You are offering a consultative service. A real prospect, even a skeptical one, will let you explain what you do. A caller fixated only on who you are, how you got the number, what your license number is — and who will not engage anything else — has not opened the door yet.",
        ],
      },
      {
        kind: "prose",
        heading: "Reading resistance — it is a dial, not a verdict",
        text: "Resistance is not the same as illegitimacy. Plenty of real prospects start guarded — they have been called before, they have been burned, they are frightened. The read is about direction of travel, not a single moment. A guarded prospect who slowly answers your questions and starts talking about their situation is warming; keep earning it. A caller who stays fully closed — no name, no problem, only questions about you — after you have given them a fair, calm chance is a different case. The lean is the same for both, and it is the opposite of chin-leading: when the guard is up, your default is to disclose less and ask more, not the reverse. You do not buy openness with information; you earn information by first creating a little openness.",
      },
      {
        kind: "prose",
        heading: "The reciprocity rule — information is earned",
        text: "Do not trade specifics into a closed door. Details about the firm, how we work, what we can pursue, and certainly anything about outcomes are things you offer as trust builds — not tools you use to pry a suspicious caller open. If someone is resistant and demanding, the move that usually serves you best is to stay warm, stay brief, and keep gently returning to them and their situation: 'I'm happy to get into all of that — first, so I'm actually helping and not guessing, tell me what the notice you got says.' If they will engage that, the guard is dropping and you can give a little more. If they will not, you hold. Measured disclosure that tracks their openness is both better selling and your best protection.",
      },
      {
        kind: "lines",
        heading: "Lines in the floor's voice",
        items: [
          "“Happy to explain who we are and exactly what we do — let me make sure this is even worth your time first. What did the letter you got actually say?”",
          "“Sounds like you've had some calls you didn't love. Fair. I'm not going to pitch at you — tell me what's going on with the taxes and I'll tell you honestly whether this is something we help with.”",
          "“I can go into all of that. Before I do — can I get your name, so I'm not talking to a stranger about tax matters?”",
          "“I hear that you want to know who I am, and I'll answer it. I do my best work when it's a two-way conversation — so give me one thing about your situation, and we'll go from there.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Leading with your chin — volunteering credentials, pitch, or outcome talk to a caller who has given you nothing. The more they withhold, the less you offer, not more.",
          "Treating guardedness as guilt. Skeptical real prospects are your bread and butter; don't punish caution with a cold read.",
          "Over-explaining to win over a hostile caller. You cannot out-inform someone who is fishing — you only hand them material.",
          "Continuing to pour information into a caller who answers nothing and only interrogates you. That is the pattern that gets quoted back at you.",
        ],
      },
      {
        kind: "example",
        weak: "“I totally understand your hesitation! We're a fully licensed tax resolution firm, we've saved clients thousands, we can absolutely help you settle for less — what's your Social so I can pull your account?”",
        strong: "“Totally fair to be cautious — you should be. Here's how I'd do this: tell me what's going on with the taxes, I'll tell you straight whether it's something we handle, and if it is I'll walk you through exactly who we are and how it works. What did you get in the mail?”",
        note: "The weak version leads with its chin — credentials, an outcome promise, and a request for sensitive data — all to a caller who has offered nothing. The strong version stays warm, discloses nothing it hasn't earned, and puts a small, reasonable ask back to the prospect. If they take it, the door is opening.",
      },
      {
        kind: "drill",
        prompt: "Caller won't give a name, won't say what notice they got, and keeps pressing 'what company is this, what's your license number, how did you get my number' — nothing else. What's your move?",
        answer: "Stay warm, stay brief, disclose nothing new. Answer the who-are-you plainly and briefly (see [[obj.who-are-you]]), then return to them once: 'Happy to keep going — tell me what the letter said and I'll know how to help.' If they engage, the guard is dropping and you proceed normally. If they will not give you a single thing about themselves or their situation after a fair chance, you do not keep feeding information — you keep it short, offer to send basic public info if appropriate, and let the call end politely. A caller who only takes and never gives is not a lost sale; disengaging cleanly is the win.",
      },
      {
        kind: "compliance",
        text: "This read protects the firm as much as it qualifies the prospect. Never let pressure or persistence pull you into promises about outcomes, fees, or agency decisions — especially with a caller you can't read. Assume any call may be recorded. The safest call with a caller who won't engage is a short, polite, boring one: concede nothing, promise nothing, document the interaction.",
      },
    ],
    links: ["obj.who-are-you", "obj.are-you-irs", "obj.scam-distrust", "script.intro"],
  },
  {
    id: "read.bad-actor",
    part: "script",
    section: "read",
    title: "The caller who is fishing — recognize and disengage",
    aliases: [
      "bad actor",
      "complaint bait",
      "entrapment caller",
      "fishing for promises",
      "trying to trap you",
      "record a promise",
      "gotcha caller",
    ],
    lead: "A small number of callers are not prospects at all. They are trying to get you on record making a promise, naming a figure, or agreeing to something the firm would never say — so they can file a complaint or make trouble. You recognize them by demeanor, not by accusation. The response is never confrontation; it is to stay calm, concede nothing, and let a boring call end.",
    blocks: [
      {
        kind: "prose",
        heading: "What fishing looks like",
        text: "The classic tell is a caller who pushes you toward statements instead of pulling you toward help. They ask you to promise an outcome — 'so you can get this wiped out, right?' They press you to name a specific savings figure or a guaranteed timeline. They invite you to bend a rule — to skip authorization, to talk about their account without verifying who they are, to say something about the IRS you would never say. They often will not give their own information while demanding yours. And they circle: whatever you answer, they steer back to trying to extract the quotable sentence. None of this requires you to decide their intent. You do not have to know why they are doing it — you only have to not give them the sentence.",
      },
      {
        kind: "moves",
        heading: "The response — in order",
        items: [
          "Stay warm and unbothered. Do not get defensive, do not accuse, do not change your tone. A calm agent gives them nothing to react to.",
          "Answer only in the firm's honest, measured language — what we do, never what the IRS will grant. If they push for a promise, describe the process instead: 'What we do is get authorized and respond — I can't tell you what the agency will decide.'",
          "Do not trade specifics or sensitive detail to satisfy pressure. Withhold exactly as you would with any guarded caller (see [[read.legitimacy]]).",
          "Let it end. If a caller will only fish, you are not losing anything by wrapping up politely. 'It sounds like this isn't the right fit right now — I'll let you go, and you're welcome to call back.' Short, courteous, over.",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Taking the bait to 'win' the call. There is no sale here to win; there is only exposure to avoid.",
          "Accusing them of being a bad actor. You may be wrong, and even if you're right, an accusation is its own headache. Just don't give them material.",
          "Matching aggression with aggression. The recording of a calm agent and an escalating caller protects you; the reverse does not.",
          "Making any promise, naming any figure, or agreeing to skip a step to get them off the phone. The exit is politeness, never a concession.",
        ],
      },
      {
        kind: "example",
        weak: "“Yes! We can absolutely settle this for pennies on the dollar, I'd say we get you down to like ten percent, guaranteed — just don't worry about the paperwork, I'll handle it.”",
        strong: "“What I can tell you is what we actually do: we get authorized on your file, we see what the IRS has, and we pursue the relief the facts support. I can't promise a number or an outcome — nobody honest can. If that's the kind of help you're after, I'm glad to keep going.”",
        note: "The weak version hands a fisher everything they came for in one breath: a guaranteed outcome, an invented figure, and a wink at skipping process. The strong version is quotable in the best way — measured, honest, and impossible to twist into a complaint.",
      },
      {
        kind: "drill",
        prompt: "Caller keeps saying 'just tell me yes or no — can you get rid of my debt, yes or no?' and won't discuss anything else. What's your move?",
        answer: "Do not give the yes. Reframe to process, once, calmly: 'It's not a yes-or-no — what we do is get authorized, review the file, and pursue what the facts support. I can't promise an outcome and I wouldn't trust anyone who did.' If they keep pressing for the binary promise and engage nothing else, that is your signal to wrap: 'I don't think I can give you what you're looking for on this call — I'll let you go.' Calm, brief, no concession. A caller who only wants the quotable 'yes' is not a prospect you're losing.",
      },
      {
        kind: "compliance",
        text: "This is the sharp end of the compliance spine. The firm never promises outcomes, dollar figures, timelines, or agency decisions, and never works an account without authorization — and those rules exist precisely for the caller who is trying to get you to break them. Assume the call is recorded. Your protection is the honest, measured sentence and the polite exit.",
      },
    ],
    links: ["read.legitimacy", "obj.scam-distrust", "obj.who-are-you"],
  },
  {
    id: "read.house-doctrine",
    part: "script",
    section: "read",
    title: "The house doctrine — certain without promising",
    aliases: [
      "bob and weave",
      "expertise without specifics",
      "certain without promising",
      "compliance and representation only",
      "what we actually sell",
      "house philosophy",
      "don't get pinned down",
    ],
    lead: "Four tenets carry every call: bob and weave — stay light on your feet and don't get pinned into specifics you don't have; show expertise without specifics; be certain you have the solution without promising outcomes; and remember what we actually sell — compliance and representation. Certainty is honest here for one reason: it is certainty about what WE do, which is entirely in our control.",
    blocks: [
      {
        kind: "prose",
        heading: "Why certainty and honesty are not in tension",
        text: "The trap in this business is thinking confidence requires promises. It is the opposite. The moment you promise an outcome — a number, a timeline, what the IRS will grant — your confidence is borrowed from something you do not control, and a sharp prospect (or a hostile one) knows it. The house position is stronger: we are completely certain about what the firm does, because the firm controls it. We get authorized, we see the file, we bring the client compliant, we represent them, and we pursue every avenue of relief the facts support. That sentence needs no hedging, survives any recording, and is more convincing than a promise — because it sounds like a professional, not a pitch.",
      },
      {
        kind: "moves",
        heading: "The four tenets in practice",
        items: [
          "Bob and weave. Hard questions come — 'how much will I save,' 'can you get this wiped,' 'what's your success rate.' Don't spar with them and don't get pinned. Answer the legitimate core honestly ('nobody can tell you that before seeing the file — and you shouldn't trust anyone who does'), then move the conversation back to their situation and the process. Declining to speculate is not evasion; it is the expertise.",
          "Expertise without specifics. Show command of the terrain — how the collections ladder works, what a notice means, what the agency does next — without attaching numbers or outcomes to THEIR case. Fluency in the process is what makes a prospect feel they've reached someone real; specifics you can't know are what get quoted back.",
          "Certain without promising. Your certainty lives in the firm's actions: authorized, compliant, represented, pursued. Say those with full confidence. Anything the IRS decides is spoken of only as possibility conditioned on facts.",
          "Compliance and representation only. That is the product and the pitch. When in doubt, return to it: 'What we do is get you compliant and represented — that's the foundation everything else depends on.'",
        ],
      },
      {
        kind: "lines",
        heading: "Lines in the floor's voice",
        items: [
          "“I can't tell you what the IRS will do — nobody honest can before seeing your file. What I can tell you with total confidence is what we do: we get authorized, we get you compliant, and we pursue everything the facts support.”",
          "“Great question, and the honest answer is: it depends on what's actually in the file. That's exactly why the first step is getting eyes on it.”",
          "“I'm not going to throw a number at you — anyone who does is guessing. What I'm certain about is the process, because we run it every day.”",
          "“What you're buying from us is compliance and representation — someone standing between you and the IRS who does this for a living. Everything good that happens starts there.”",
        ],
      },
      {
        kind: "avoid",
        items: [
          "Borrowing certainty from outcomes — any sentence where your confidence depends on what the IRS grants.",
          "Getting pinned into a specific to end the pressure. The number you invent to escape a hard question is the number that ends up in a complaint.",
          "Mistaking bob-and-weave for dodging accountability. You always answer the honest core of the question — what you decline is the speculation, and you say so out loud.",
          "Talking settlements and forgiveness as the product. The product is compliance and representation; relief is what the facts may support.",
        ],
      },
      {
        kind: "example",
        weak: "“Honestly? Clients like you usually end up paying about 20 cents on the dollar. We'll get this settled in six months, guaranteed — that's what we do.”",
        strong: "“Here's what I can promise, because it's ours to control: we get authorized on your file, we get you compliant — which stops the bleeding — and we represent you in front of the IRS, pursuing every form of relief your facts support. What that ends up looking like depends on the file. That's the honest version, and it's the one that actually works.”",
        note: "The weak version borrows certainty from a number and a timeline it doesn't own. The strong version is MORE confident, not less — every claim in it is fully controlled by the firm, so it can be delivered without a flicker of hedge.",
      },
      {
        kind: "drill",
        prompt: "Prospect, friendly but sharp: “Just ballpark it for me — what do people usually save with you guys?” What's your move?",
        answer: "Bob and weave: answer the honest core, decline the speculation, return to process. “I get why you're asking, and I'll be straight: any number I gave you before seeing your file would be a guess dressed up as a fact — and you'd be right not to trust it. What I can tell you is that the people who do best tend to be the ones who get compliant and represented early, because that's what creates the options. Let's find out what your file actually says.” No number leaves your mouth; the confidence comes from the refusal.",
      },
      {
        kind: "compliance",
        text: "This entry IS the compliance spine restated as a selling philosophy. Certainty attaches only to firm-controlled actions (authorization, compliance work, representation, pursuit of relief). Outcomes, figures, timelines, and agency decisions are never promised — not to close, not to comfort, not to end pressure. If a sentence's confidence depends on the IRS, rewrite the sentence.",
      },
    ],
    links: ["read.legitimacy", "read.bad-actor", "script.pitch", "obj.how-can-i-trust"],
  },
];
