"use strict";

// Raw-STT stress: the clean fixtures are one-utterance-per-turn, so they don't exercise the real failure
// mode. Here we EXPAND each clean turn into a realistic raw STT event stream — partials (must be dropped),
// the final (should count), plus the artifacts a live call actually produces: backchannel finals ("mm-hm",
// "yeah") and garble finals ("[static]", "the the uh"). Then we run the "count 3 turns" trigger two ways:
//   NAIVE  commit: every FINAL becomes a countable turn (no substance filter)
//   ROBUST commit: only FINALS with >= MIN_WORDS real words, non-garble, count
// The delta = how badly an unfiltered commit layer inflates the count and fires the coach on noise.

const fs = require("fs");
const path = require("path");

const MIN_WORDS = 2; // a committed turn must carry >= this many real (non-backchannel) words
const BACKCHANNEL = new Set(["yeah", "yes", "no", "okay", "ok", "sure", "right", "mm", "mmm", "mhm", "uh", "um", "uh-huh", "mm-hm", "gotcha", "correct", "exactly", "hello"]);
const GARBLE = /\[[^\]]*\]|zz+t?|para español|press one|oprima|the the uh|the the mm|\bmmf\b|\bnnh\b/i;

function substWordCount(text) {
  const cleaned = String(text || "").replace(/\[[^\]]*\]/g, " ").replace(GARBLE, " ").replace(/[^a-z0-9'\s-]/gi, " ").trim();
  const words = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  return words.filter((w) => !BACKCHANNEL.has(w.toLowerCase())).length;
}
const isGarble = (t) => GARBLE.test(String(t || "")) && substWordCount(t) < 2;

// Deterministic raw-stream expansion of clean turns (no RNG — pattern-based, so it's reproducible).
function expandToStream(turns) {
  const events = [];
  turns.forEach((t, i) => {
    const words = String(t.text).split(/\s+/);
    // 2 partials (growing prefixes) — these are is_final:false and must never be committed
    if (words.length > 6) events.push({ final: false, text: words.slice(0, 3).join(" ") });
    if (words.length > 12) events.push({ final: false, text: words.slice(0, 8).join(" ") });
    // the real final
    events.push({ final: true, text: t.text });
    // realistic artifacts on the FINAL channel:
    if (i % 2 === 1) events.push({ final: true, text: ["mm-hm", "yeah", "okay", "right"][i % 4] }); // a backchannel grunt
    if (i % 5 === 4) events.push({ final: true, text: "[static]" });                                  // a garble final
  });
  return events;
}

function fires(events, robust) {
  let since = 0, n = 0, noiseDriven = 0, counted = 0, windowNoise = 0;
  for (const e of events) {
    if (!e.final) continue; // partials never count either way (finals-only is the ONE guard both modes share)
    const noise = isGarble(e.text) || substWordCount(e.text) < MIN_WORDS;
    const countsHere = robust ? !noise : true;
    if (countsHere) { since += 1; counted += 1; if (noise) windowNoise += 1; }
    if (since >= 3) { n += 1; if (windowNoise >= 2) noiseDriven += 1; since = 0; windowNoise = 0; }
  }
  return { n, noiseDriven, counted };
}

const dir = __dirname;
const fixtures = fs.readdirSync(dir).filter((f) => /^fixture-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort();

console.log("RAW-STT STRESS — 3-turn trigger over a realistic raw stream (partials + backchannel + garble finals)\n");
console.log("  fixture               | real turns | NAIVE fires (noise-driven) | ROBUST fires | extra fires from noise");
let tN = 0, tR = 0, tNoise = 0;
for (const name of fixtures) {
  const fx = require(path.join(dir, name));
  const ev = expandToStream(fx.turns);
  const naive = fires(ev, false);
  const robust = fires(ev, true);
  tN += naive.n; tR += robust.n; tNoise += naive.noiseDriven;
  console.log(
    `  ${name.padEnd(21)} |    ${String(fx.turns.length).padStart(2)}      |   ${String(naive.n).padStart(2)}  (${String(naive.noiseDriven).padStart(2)} noise-driven)      |     ${String(robust.n).padStart(2)}       |  +${naive.n - robust.n}`,
  );
}
console.log(`\n  TOTALS: NAIVE ${tN} fires (${tNoise} noise-driven), ROBUST ${tR} fires  ->  an unfiltered commit fires ${Math.round(((tN - tR) / tR) * 100)}% MORE, on noise.`);
console.log("\n  Guardrails a robust commit/trigger needs (all pure/deterministic, no model):");
console.log("   1. FINALS ONLY  — never count is_final:false partials  (both modes already assume this)");
console.log(`   2. SUBSTANCE FLOOR — a turn must carry >= ${MIN_WORDS} real words; drop pure backchannel ('yeah','mm-hm')`);
console.log("   3. GARBLE DROP  — never count bracketed/IVR/repeated-token noise ('[static]','press one','the the uh')");
console.log("   4. DEDUP        — idempotent: the same phrase can't be appended twice");
