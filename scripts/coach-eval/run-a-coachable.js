"use strict";

// Coachability-gate probe: does Haiku correctly SLEEP (empty say) on filler / small-talk / acknowledgment,
// but WAKE and develop a line on a pivotal turn — including a pivotal SHORT turn ("No." / "How much?")
// that a word-count filter would wrongly drop? Grounds one B cockpit, then runs each test turn on Haiku.

const path = require("path");
const { buildStrategistRequest, buildCoachRequest } = require("../../packages/shared-services/src/coachTwoStationPrompts");
const { buildReferenceBody } = require("../../packages/shared-services/src/coachReferenceLibrary");
const { createApiRunner, loadEnvKey } = require("./apiRunner");

const CASES = [
  // COACHABLE — expect a developed line
  { id: "reject-short   [coachable]", text: "prospect: No." },
  { id: "price-q        [coachable]", text: "prospect: How much is this gonna cost me?" },
  { id: "buy-short      [coachable]", text: "prospect: Okay yeah, let's do it." },
  { id: "price-objection[coachable]", text: "prospect: Thirty-five hundred? I can't afford that right now." },
  // NON-COACHABLE — expect SLEEP (empty say)
  { id: "backchannel  [should sleep]", text: "prospect: mm-hm." },
  { id: "filler-ack   [should sleep]", text: "prospect: yeah, okay." },
  { id: "encourage    [should sleep]", text: "prospect: right, that makes sense, go on." },
  { id: "small-talk   [should sleep]", text: "prospect: oh my nephew goes to school out there too, small world." },
];

(async () => {
  const apiKey = loadEnvKey(path.join(__dirname, "..", "..", ".env"));
  const reference = buildReferenceBody();
  const bRun = createApiRunner({ apiKey, model: "claude-sonnet-5" });
  const aRun = createApiRunner({ apiKey, model: "claude-haiku-4-5", maxTokens: 800 });

  const fx = require(path.join(__dirname, "fixture-fast-yes"));
  const transcript = fx.turns.slice(0, 12).map((t) => `${t.speaker}: ${t.text}`).join("\n"); // close zone
  const bReq = buildStrategistRequest({ reference, transcript, priorSummaryText: "" });
  const bRes = await bRun({ system: bReq.system, prompt: bReq.prompt });
  const cockpit = (bRes.json && bRes.json.guidance && bRes.json.guidance[0]) || {};
  const says = Array.isArray(cockpit.says) ? cockpit.says : [];
  const recSay = (says.find((s) => s && s.rec) || says[0] || {}).text || "";
  const summary = (typeof bRes.json?.summary === "string" ? bRes.json.summary : "") || "";
  console.log(`B cockpit @turn12 §${cockpit.currentSection} says=${says.length}\n`);

  for (const c of CASES) {
    const req = buildCoachRequest({ currentSection: cockpit.currentSection || "", says, priorGuidance: recSay, summaryText: summary, lastTurns: c.text });
    const res = await aRun({ system: req.system, prompt: req.prompt });
    const say = res.json ? res.json.say : undefined;
    const out = say === "" || say == null ? "😴 SLEEP" : `🗣  ${say}`;
    console.log(`  ${c.id}\n     turn: ${c.text}\n     -> ${String(out).slice(0, 200)}\n`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
