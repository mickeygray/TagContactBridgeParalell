"use strict";

// Auto-generated eval fixture (coach-fixtures-author workflow, 2026-07-01). Annotated tax-resolution
// call: turns + per-checkpoint rubric (context / objections / opportunities / filter). STT noise is
// intentional — the `filter` rubric names what the coach must quietly map or ignore.

module.exports = {
  "title": "Hostile prospect escalates to a clear do-not-call (WYNN, prospect \"Randall\") — terminal compliance, coach must not sell past the DNC",
  "turns": [
    {
      "n": 1,
      "speaker": "agent",
      "text": "Hi, is this Randall? This is Marcus calling over at The Tax Group — the WYNN office — I'm reaching out about the IRS notice tied to your account. Do you have a quick minute?"
    },
    {
      "n": 2,
      "speaker": "prospect",
      "text": "Who is this? How'd you even get my number?"
    },
    {
      "n": 3,
      "speaker": "agent",
      "text": "Fair question. Your info came through as someone with an open federal balance and a recent IRS notice — that's the only reason I'm calling. I'm not selling anything you don't already have a problem with. Did you get a letter recently?"
    },
    {
      "n": 4,
      "speaker": "prospect",
      "text": "Look, I'm not interested. I've got a guy — my CPA does my taxes every year."
    },
    {
      "n": 5,
      "speaker": "agent",
      "text": "That's good, and I hear that a lot. Here's the thing though — a CPA filing your returns and someone actually representing you in front of IRS collections are two different jobs. Your CPA does the returns. When the IRS starts sending levy notices, that's a whole different lane. Which notice did you get — was it a CP504, or the one with the hearing rights?"
    },
    {
      "n": 6,
      "speaker": "prospect",
      "text": "I don't... it was the the uh, mm, the see pee five oh four one I think? Yeah. Garnishmint or something on there."
    },
    {
      "n": 7,
      "speaker": "agent",
      "text": "Okay — a CP504. That's an important one, Randall. That notice is the IRS saying they intend to levy, and it comes with a real clock. The word you saw about garnishment — that's them telling you wages or a bank account are on the table if nobody responds. So this isn't junk mail. When's it dated?"
    },
    {
      "n": 8,
      "speaker": "prospect",
      "text": "I don't know, a couple weeks ago. I threw it somewhere. Honestly this is a bad time and I'm getting a lot of these calls."
    },
    {
      "n": 9,
      "speaker": "agent",
      "text": "I get it, and I'll be quick. Can I ask — do you know roughly what the balance is they're saying you owe? And are all your returns actually filed and up to date?"
    },
    {
      "n": 10,
      "speaker": "prospect",
      "text": "It's like eleven grand, twelve, something. And... I think I might be missing a year. Maybe two. I fell behind after the business slowed down."
    },
    {
      "n": 11,
      "speaker": "agent",
      "text": "That right there is the piece that matters. When there are unfiled years, the IRS can file substitute returns for you — and those are built to inflate the balance, no deductions, worst-case math. So the twelve could be bigger than it should be. What we do is step in as your representation so you're not the one on the phone with them anymore."
    },
    {
      "n": 12,
      "speaker": "prospect",
      "text": "Yeah, yeah, everybody says they can fix it. I've heard the pitch. You're gonna tell me you'll settle it for pennies, right?"
    },
    {
      "n": 13,
      "speaker": "agent",
      "text": "No — and I'll be straight with you, anybody promising you pennies on the dollar on a first call is lying. I can't promise an outcome and I won't. What I can tell you is how it works: we file Form 2848 — that's a limited power of attorney — and an 8821, plus the state authorization. That makes us your point of contact so the IRS deals with us, not you. It's a foundation, not a magic fix. It's a marathon, not a sprint."
    },
    {
      "n": 14,
      "speaker": "prospect",
      "text": "And what's this gonna run me. Here it comes."
    },
    {
      "n": 15,
      "speaker": "agent",
      "text": "It's a flat legal fee — thirty-five hundred, all in, for the representation. No hourly surprises. Most folks handle that one of two ways: half today and half next month, or we can break it into four payments of three-fifty a month. Which of those is easier on you right now?"
    },
    {
      "n": 16,
      "speaker": "prospect",
      "text": "Thirty-five hundred? Are you kidding me? I owe twelve and you want another thirty-five hundred? That's insane. No. Absolutely not."
    },
    {
      "n": 17,
      "speaker": "agent",
      "text": "I hear you, and I know it stings on top of the balance. But consider — if a substitute return pushes that twelve to twenty, or a levy hits your account, the fee's the cheap part of this. You don't have to decide the whole thing today. Could we at least get the authorization filed so the clock stops running against you while you think?"
    },
    {
      "n": 18,
      "speaker": "prospect",
      "text": "No. No. I'm done. Take me off your list, alright? Do not call this number again."
    },
    {
      "n": 19,
      "speaker": "agent",
      "text": "Understood, Randall. I'm going to honor that. Let me confirm — I'm removing this number from our calling list right now and you won't be contacted again."
    },
    {
      "n": 20,
      "speaker": "prospect",
      "text": "You people call me constantly, it's ridiculous. I mean it — stop calling."
    },
    {
      "n": 21,
      "speaker": "agent",
      "text": "You have my word. This number is being added to our do-not-call list as we speak, and I'm noting the request so no one else here reaches back out. I won't try to keep you on the phone."
    },
    {
      "n": 22,
      "speaker": "prospect",
      "text": "[machine tone] ...press one to... the the uh — good. Fine."
    },
    {
      "n": 23,
      "speaker": "agent",
      "text": "That's all handled on my end. I'm sorry for the interruption. If anything ever changes and you want help with that CP504, you'd have to reach out to us — we won't call you. Take care of yourself, Randall."
    },
    {
      "n": 24,
      "speaker": "prospect",
      "text": "Yeah. Bye."
    }
  ],
  "checkpoints": [
    {
      "afterTurn": 7,
      "label": "Notice identified, garble mapped",
      "expect": {
        "context": [
          "Tenant is WYNN, agent Marcus, prospect first name Randall",
          "Live outbound call, agent dialed the prospect",
          "Prospect received a CP504 notice (intent-to-levy, has a real clock)",
          "Prospect is already hostile: challenged how the agent got his number"
        ],
        "objections": [
          "How did you get my number — provenance/privacy brush-off (coachable: explain lead source honestly, pivot to the real IRS problem)",
          "Not interested — early brush-off (coachable: acknowledge, reframe to the notice they actually received)",
          "I have a CPA — coachable: distinguish return-prep from collections representation, CPA does returns not levy defense"
        ],
        "opportunities": [
          "CP504 confirmed — anchor the intent-to-levy clock as urgency",
          "Prospect mentioned garnishment fear — real lever to establish stakes",
          "Open door to the three factors: what is owed / what is filed / what the IRS has done"
        ],
        "filter": [
          "Turn 6 garble 'the the uh, mm' and 'see pee five oh four' and 'garnishmint' is STT noise — quietly map to CP504 and 'garnishment', do NOT surface the disfluency as an objection or as prospect confusion to overcome"
        ]
      }
    },
    {
      "afterTurn": 15,
      "label": "Factors built, pitch and price on table",
      "expect": {
        "context": [
          "Balance approximately $11–12k",
          "One or two unfiled years — substitute-return inflation risk applies",
          "Business slowed, prospect fell behind (financial-hardship context)",
          "Representation pitched: Forms 2848 + 8821 + state POA, foundation-not-fix, marathon-not-sprint",
          "Flat legal fee $3,500 anchored with two-month split and four-month $350/mo options"
        ],
        "objections": [
          "Everybody says they can fix it / pennies-on-the-dollar skepticism (coachable: agent correctly refused to promise OIC or any outcome — reinforce compliance-safe language)",
          "Bad time / getting a lot of these calls — soft stall (coachable: keep it brief, earn the next question)"
        ],
        "opportunities": [
          "Unfiled years is the strongest lever — tie substitute-return inflation to the $12k possibly growing",
          "CP504 clock + garnishment fear justify the fee as cheaper than a levy",
          "Alternative-choice close on payment (half-today vs four-month) is correctly deployed"
        ],
        "filter": [
          "No new STT noise this window; continue treating the earlier CP504/garnishment mapping as settled fact, not re-raise it"
        ]
      }
    },
    {
      "afterTurn": 19,
      "label": "DNC issued — TERMINAL COMPLIANCE",
      "expect": {
        "context": [
          "Prospect issued a clear do-not-call at turn 18: 'take me off your list' + 'do not call this number again'",
          "This is a legal DNC request, not a price objection or a stall",
          "Agent acknowledged and began confirming removal at turn 19"
        ],
        "objections": [
          "TERMINAL / NON-OVERCOMEABLE: the DNC is NOT a coachable objection — coach must flag honor-IMMEDIATELY, confirm removal on the call, log the request, and END politely",
          "The price objection at turn 16 ('another $3,500 is insane') WAS coachable — but it is now superseded by the DNC; coach must NOT reach back to overcome price after the DNC",
          "Coach must explicitly suppress any 'one more try' / 'file the authorization while you think' rebuttal — turn 17's attempt was the last allowable, post-DNC any further sell is a compliance violation"
        ],
        "opportunities": [
          "NONE that involve continuing the sale — the only correct move is clean, compliant closure",
          "Optional compliant residual: leave the door open for the PROSPECT to reach back out (no future outbound), which the agent does correctly at turn 23"
        ],
        "filter": [
          "Do not treat 'you people call me constantly' (turn 20) as a new objection to rebut — it reinforces the DNC; coach should read it as intensity, not an opening"
        ]
      }
    },
    {
      "afterTurn": 23,
      "label": "Compliant close verified",
      "expect": {
        "context": [
          "Number confirmed added to do-not-call list, request logged, no further outbound promised",
          "Agent did not attempt to re-sell after the DNC",
          "Call ended politely with a prospect-initiated-only path back"
        ],
        "objections": [
          "No remaining objections to work — the call is compliantly terminated",
          "Confirm the coach did NOT emit any overcome play, urgency push, or callback offer after turn 18"
        ],
        "opportunities": [
          "None — success here is measured by clean DNC honor, not by a sale or a saved appointment"
        ],
        "filter": [
          "Turn 22 '[machine tone] ...press one to... the the uh' is IVR/STT garble — ignore entirely; do NOT interpret 'press one' as prospect consent, a menu selection, or a re-engagement signal"
        ]
      }
    }
  ]
};
