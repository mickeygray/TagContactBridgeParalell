"use strict";
// Re-test the two misses ("No." / "let's do it") BARE vs WITH the agent's preceding line, to see if the
// miss was context-starvation (bare single turn) rather than bad coachability judgment.
const path = require("path");
const { buildStrategistRequest, buildCoachRequest } = require("../../packages/shared-services/src/coachTwoStationPrompts");
const { buildReferenceBody } = require("../../packages/shared-services/src/coachReferenceLibrary");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

const CASES = [
  { id: "No.            BARE", text: "prospect: No." },
  { id: "No.         +CONTEXT", text: "agent: Perfect — let's get you set up, I'll take the card for the first payment now.\nprospect: No." },
  { id: "let's do it     BARE", text: "prospect: Okay yeah, let's do it." },
  { id: "let's do it  +CONTEXT", text: "agent: So should we get the paperwork started today?\nprospect: Okay yeah, let's do it." },
];

(async () => {
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const reference = buildReferenceBody();
  const bRun = createApiRunner({ apiKey, model: "claude-sonnet-5" });
  const aRun = createApiRunner({ apiKey, model: "claude-haiku-4-5", maxTokens: 800 });
  const fx = require(path.join(__dirname, "fixture-fast-yes"));
  const bReq = buildStrategistRequest({ reference, transcript: fx.turns.slice(0, 12).map((t) => `${t.speaker}: ${t.text}`).join("\n"), priorSummaryText: "" });
  const bRes = await bRun({ system: bReq.system, prompt: bReq.prompt });
  const cockpit = (bRes.json && bRes.json.guidance && bRes.json.guidance[0]) || {};
  const says = Array.isArray(cockpit.says) ? cockpit.says : [];
  const recSay = (says.find((s) => s && s.rec) || says[0] || {}).text || "";
  const summary = (typeof bRes.json?.summary === "string" ? bRes.json.summary : "") || "";
  for (const c of CASES) {
    const req = buildCoachRequest({ currentSection: cockpit.currentSection || "", says, priorGuidance: recSay, summaryText: summary, lastTurns: c.text });
    const res = await aRun({ system: req.system, prompt: req.prompt });
    const say = res.json ? res.json.say : undefined;
    console.log(`  ${c.id}  ->  ${say === "" || say == null ? "😴 SLEEP" : "🗣  " + String(say).slice(0, 150)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
