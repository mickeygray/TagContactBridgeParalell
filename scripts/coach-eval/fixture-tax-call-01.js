"use strict";

// Annotated eval fixture — one realistic outbound tax-resolution call (agent dials prospect),
// 28 turns, with a grading RUBRIC: at each checkpoint, what the coach SHOULD discover
// (objections), find (sales opportunities), and update (context/facts). Includes two STT-noise
// turns (garbled / phonetic) to test the coach's ability to FILTER 4o-transcribe errors.
//
// This is the "brain" test: run the STRATEGIST prompt on the transcript-so-far at each checkpoint,
// then diff its output against `expect`. Shape correctness is secondary here — this round is about
// getting the RESULTS right.

const turns = [
  { n: 1, speaker: "agent", text: "Hi, is this Robert? This is Mike over at The Tax Group — your name came up in some public tax records, looks like there might be an active federal matter. Did you get any notices from the IRS recently?" },
  { n: 2, speaker: "prospect", text: "Uh, who is this again? What's this about?" },
  { n: 3, speaker: "agent", text: "Mike, with The Tax Group — we're a licensed tax representation firm, enrolled agents. We help people get represented with the IRS so you're not dealing with them alone. Fair to take thirty seconds?" },
  { n: 4, speaker: "prospect", text: "I mean, yeah, I did get a letter. A CP504 I think it was." },
  { n: 5, speaker: "agent", text: "Okay — a CP504, that's an intent to levy, so they're getting ready to take collection action. Roughly how much are they saying you owe?" },
  { n: 6, speaker: "prospect", text: "It's like forty five grand. Probably more with the penalties honestly." },
  { n: 7, speaker: "agent", text: "Got it. And are you all filed up, or are there years still outstanding?" },
  { n: 8, speaker: "prospect", text: "I'm behind, probably three years. I'm self-employed so it's kind of a mess." },

  { n: 9, speaker: "agent", text: "That's super common and it's fixable — the self-employment piece is usually where a lot of the balance comes from, and representation lets us separate what's actually yours. So how does—" },
  { n: 10, speaker: "prospect", text: "Yeah, how much does something like this even cost?" },
  { n: 11, speaker: "agent", text: "Fair question — the flat legal fee is $3,500. That covers the POA filings, pulling your full IRS transcripts, and the attorney-led compliance review. Before we get there though—" },
  { n: 12, speaker: "prospect", text: "Whoa, thirty five hundred. I don't know man, I'd have to talk to my wife about something like that." },
  { n: 13, speaker: "agent", text: "Totally get wanting to loop her in. Can I ask — is it the amount, or more about whether this is the right move for you?" },
  { n: 14, speaker: "prospect", text: "It's a lot of money. And honestly, how do I even know you guys are legit? I'm not trying to get scammed here." },

  { n: 15, speaker: "agent", text: "Good instinct, you should ask that. Licensed firm, enrolled agents — I can text you our site and Google reviews right now while we talk. But here's the thing about that CP504—" },
  { n: 16, speaker: "prospect", text: "the the uh mm yeah okay the leen thing" },
  { n: 17, speaker: "agent", text: "Right — so a lien and a levy are different animals. The levy, the CP504, that's the one with the clock on it. Once you're represented we can request a hold while we review. Do you already work with anyone, a CPA?" },
  { n: 18, speaker: "prospect", text: "I've got a CPA who does my taxes but he doesn't touch the IRS collections stuff." },
  { n: 19, speaker: "agent", text: "Right, and that's the key difference — a CPA filing returns isn't the same as being represented in collections. That's exactly what the 2848 authorization does. So on the fee—" },
  { n: 20, speaker: "prospect", text: "Look, I want to deal with it, I genuinely just can't do thirty five hundred right now. Money's tight." },

  { n: 21, speaker: "agent", text: "I hear you — and honestly it's because money's tight that the levy matters, if they garnish your wages you lose way more than the fee. Most folks in your spot start with two payments: half today to open the case, the rest in thirty days. Would that make it workable?" },
  { n: 22, speaker: "prospect", text: "Half today, so that's like eighteen hundred?" },
  { n: 23, speaker: "agent", text: "Right, $1,750 today to get the POA filed and stop the guessing, balance in thirty days — and your attorney's team is on it right away." },
  { n: 24, speaker: "prospect", text: "okay yeah and see pee five oh four thats the one thats urgent right" },
  { n: 25, speaker: "prospect", text: "let me uh, can you text me that reviews thing first, then i think we can do the eighteen hundred" },
  { n: 26, speaker: "agent", text: "Texting it now. Once you glance at that we'll get the first payment in and file your POA today so that levy clock stops mattering. Sound good?" },
  { n: 27, speaker: "prospect", text: "yeah okay, let's do it" },
  { n: 28, speaker: "agent", text: "Perfect — let me grab your info to get the file started." },
];

// Each checkpoint = run the strategist on turns[0..afterTurn], diff against these expectations.
const checkpoints = [
  {
    afterTurn: 8,
    label: "post-discovery",
    expect: {
      context: ["CP504 = intent-to-levy notice (urgent clock)", "balance ~$45k", "3 unfiled years", "self-employed"],
      objections: ["early skepticism / who-is-this (turn 2)"],
      opportunities: ["URGENCY: CP504 levy clock is the lever", "self-employed → blended liability angle"],
      filter: [],
    },
  },
  {
    afterTurn: 14,
    label: "first-objection-cluster",
    expect: {
      context: ["fee quoted = $3,500", "wife involved in decision"],
      objections: ["spouse stall (talk to my wife)", "skepticism / scam (are you legit)", "price reaction to $3,500"],
      opportunities: ["BUYING SIGNAL: prospect asked the price (turn 10) = picturing themselves as a client", "isolate move is in play"],
      filter: [],
    },
  },
  {
    afterTurn: 20,
    label: "incumbent-and-affordability",
    expect: {
      context: ["has a CPA — returns only, not collections"],
      objections: ["incumbent CPA", "price / can't-afford (test: CAN'T vs WON'T — condition or objection?)"],
      opportunities: ["CPA-filing ≠ representation reframe", "BOOMERANG: money-tight is the reason to act (garnishment)", "payment ladder / anchor"],
      filter: ["turn 16 'the the uh mm yeah okay the leen thing' is STT garble — do NOT surface it as a real objection; at most map 'leen'→lien quietly"],
    },
  },
  {
    afterTurn: 25,
    label: "moving-to-close",
    expect: {
      context: ["agreed direction: two-pay, $1,750 today", "wants the reviews/site link first", "CP504 reaffirmed"],
      objections: ["softening / largely resolved"],
      opportunities: ["TAKE-THE-YES: negotiating terms (turn 22) = commitment shift → stop selling, move to logistics", "text the reviews link then collect payment"],
      filter: ["turn 24 'see pee five oh four' is phonetic STT for CP504 — map it correctly, not as noise"],
    },
  },
];

module.exports = { title: "Outbound tax-resolution call — Robert (WYNN)", turns, checkpoints };
