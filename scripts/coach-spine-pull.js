"use strict";

// Real Opus deep pull for the NEW division of labor:
//   SCRIPT  = the lean checklist of points to hit in this section ("hit this, this, this").
//   COACH   = thicker: Opus tracks which beats are hit/fumbled, names the best tact to take,
//             and HOLDS THE LINES — drawing 2-4 sayable options for this exact prospect/moment
//             and marking the single best. The verbatim language lives with the coach, not the script.

const { buildReferenceBody } = require("../packages/shared-services/src/coachReferenceLibrary");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");

const REFERENCE = buildReferenceBody(); // leads with TAX_GROUP_SCRIPT
const t = (role, text) => ({ role, text });

const SECTIONS = [
  "1 Introduction · 2 Case building (discovery+pain) · 3 Expert guidance (three factors) · 4 Representation pitch (2848/8821/POA, fee) · 4B Payment/close (state fee, pause, walk the ladder) · 5 Info collection · 6 Think-it-over · 7 Closing",
];

const calls = [
  { sessionId: "coach-sean", who: "Robert M.", tenant: "WYNN", caseId: "884412",
    turns: [
      t("agent", "We'd file the FTA, address the lien, put protection between you and collections. To open the case the fee is eighteen hundred."),
      t("prospect", "Eighteen hundred is a lot. And what's stopping me from just calling the IRS myself?"),
      t("agent", "Fair question — when you've dealt with the IRS before, how did that go?"),
      t("prospect", "I called once, sat on hold two hours, got nowhere."),
      t("prospect", "So you can actually stop the garnishment? Because that's what I care about."),
    ] },
  { sessionId: "coach-dana", who: "Alicia P.", tenant: "TAG", caseId: "771200",
    turns: [
      t("agent", "I see a notice came across — what's going on?"),
      t("prospect", "I got a CP504. I haven't filed in like three years. I'm self-employed."),
      t("agent", "You're in the right place. Do you know roughly how much you owe?"),
      t("prospect", "No idea. I just don't want them taking money out of my account."),
    ] },
  { sessionId: "coach-mike", who: "Gerald T.", tenant: "WYNN", caseId: "905631",
    turns: [
      t("agent", "So we're set — 2848, 8821, state POA filed today. Four months at three-fifty."),
      t("prospect", "Okay. Can I think about it over the weekend and call Monday?"),
      t("agent", "Totally fair."),
      t("prospect", "I'm just nervous committing on the spot."),
    ] },
];

const SYSTEM = [
  "You are the STRATEGIC tier (Opus) of a live sales-call coach for The Tax Group's approved 7-section method.",
  "The SCRIPT is the fixed checklist of points to hit per section. YOUR job (the coach) is the analysis:",
  "track which beats are hit vs fumbled, name the best tactic to take right now, and PICK THE BEST LINE — you hold the language, the agent just needs the right words.",
  "",
  "SECTIONS: " + SECTIONS.join("\n"),
  "",
  "=== COACH REFERENCE (full method + tactics + objection language) ===",
  REFERENCE,
  "",
  "=== OUTPUT CONTRACT ===",
  "Return ONLY JSON: { \"guidance\": [ ... ] }, one entry per call. Each entry:",
  "  sessionId (echo verbatim), currentSection (e.g. \"2\" or \"4B\"),",
  "  beats: array of { point, status } — the SCRIPT's points to hit in the current section, each status one of hit | pending | fumbled (fumbled = attempted/relevant but done wrong or skipped when it mattered).",
  "  bestTact: ONE or two sentences — the best approach to take right NOW given where the call is.",
  "  lines: array of { text, best } — 2 to 4 SAYABLE lines you've drawn for THIS prospect and THIS moment (real, specific, ready to read aloud). Mark exactly one with best:true.",
  "  read: what's happening now. steer: the move. confidence: low|medium|high.",
].join("\n");

const PROMPT = "ACTIVE CALLS:\n\n"
  + calls.map((c) => `--- sessionId=${c.sessionId}  ${c.who} · ${c.tenant} ${c.caseId} ---\n` + c.turns.map((x) => `${x.role}: ${x.text}`).join("\n")).join("\n\n")
  + "\n\nReturn the JSON now.";

const SCHEMA = { type: "object", properties: { guidance: { type: "array", items: { type: "object", properties: {
  sessionId: {}, currentSection: {}, beats: {}, bestTact: {}, lines: {}, read: {}, steer: {}, confidence: {},
} } } } };

(async () => {
  const opus = createClaudeAgentRunner({ model: "opus", maxThinkingTokens: 0, timeoutMs: 180000 });
  const startedAt = Date.now();
  const res = await opus({ system: SYSTEM, prompt: PROMPT, schema: SCHEMA });
  console.log(`ok=${res.ok} elapsedMs=${Date.now() - startedAt} usage=${JSON.stringify(res.usage || null)}`);
  if (!res.ok) { console.log("ERR", res.error, String(res.text || "").slice(0, 500)); return; }
  const parsed = res.json || (() => { try { return JSON.parse(res.text); } catch { return { guidance: [] }; } })();
  console.log(JSON.stringify(parsed.guidance || parsed, null, 2));
})().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
