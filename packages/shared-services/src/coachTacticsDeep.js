"use strict";

// TACTICS section (trimmed). The 21 situational TACTIC_RULES (guidance only — the
// per-rule family tags + tone notes are gone, folded into one TONE line), plus the
// named advanced moves (tactical empathy, Sandler, Cialdini) as one tight list.
// Objections and tax have their own sections; no overlap, no commentary.

const { TACTIC_RULES } = require("./liveCoachSanitizedPipeline");

function formatTacticsRules() {
  return ["SITUATIONAL TACTICS — use the one that fits the moment:"]
    .concat(TACTIC_RULES.map((t) => `- ${t.label}: ${t.guidance}`))
    .join("\n");
}

const ADVANCED_MOVES = `ADVANCED MOVES:
- Mirror: repeat their last 1-3 words back as a question to keep them talking.
- Label the feeling: "it sounds like / it seems like" (never "I understand").
- Calibrated "how/what" questions that make them solve it ("how am I supposed to help if we can't see your file?").
- Accusation audit: say their objection first ("you're probably thinking this is another scam call").
- Aim for "that's right" (real agreement), not "you're right" (polite brush-off).
- The voice: calm, slow, downward inflection under fear or hostility; never match their heat.
- No-oriented questions ("is now a bad time?") feel safer than chasing a yes.
- Boomerang: the objection is the reason to act ("it's BECAUSE money's tight that the garnishment matters").
- Isolate before answering ("if we solved that, anything else?"); close on an alternative choice, never yes/no.
- Pain funnel: tell me more -> how long -> what have you tried -> how'd that work -> what's it costing you.
- Authority + social proof: licensed firm, enrolled agents, "most clients in your spot," "we do this every day."
- Honest urgency: the notice has a real clock and penalties compound — the situation, never manufactured pressure.
- Take the yes: when they lean in, stop selling and move to logistics; extra value re-opens the decision.`;

const TONE = `TONE: calm authority always. No humor under enforcement, fear, distrust, fees, anger, or any do-not-call — there it reads as mockery; honor an explicit DNC instantly. Light warmth only when the prospect is genuinely calm. Silence after a number or a question is powerful — don't rush to fill it.`;

function buildTacticsSection() {
  return [formatTacticsRules(), "", ADVANCED_MOVES, "", TONE].join("\n");
}

module.exports = { ADVANCED_MOVES, TONE, formatTacticsRules, buildTacticsSection };
