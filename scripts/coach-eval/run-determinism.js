"use strict";

// Determinism probe: the coach's fire decision is a PURE function of the committed transcript (no model).
// The 3-turn trigger is only as good as the turns it counts. This runs the trigger over the real (noisy)
// fixture dialog and asks: do garble-only / backchannel / short turns inflate the count and fire the coach
// on nothing? It also contrasts NAIVE counting (every committed row) vs ROBUST counting (only substantive
// turns), to quantify what a substance filter in the commit layer buys.

const fs = require("fs");
const path = require("path");

const BACKCHANNEL = new Set([
  "yeah", "yea", "yes", "no", "okay", "ok", "sure", "right", "mm", "mmm", "mhm", "uh", "um", "hello",
  "bye", "thanks", "thank you", "gotcha", "hang on", "one sec", "uh-huh", "mm-hm", "correct", "exactly",
]);
// STT-noise / garble markers seen in real transcripts.
const GARBLE = /\[[^\]]*\]|zz+t?|zz+k|para español|press one|oprima|the the uh|the the mm|\bmmf\b|\bnnh\b/i;

function classify(text) {
  const raw = String(text || "").trim();
  // strip bracketed noise + obvious garble tokens, then measure real words
  const cleaned = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(GARBLE, " ")
    .replace(/[^a-z0-9$'\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned ? cleaned.split(" ").filter(Boolean) : [];
  const substWords = words.filter((w) => !BACKCHANNEL.has(w.toLowerCase()));
  const hasGarble = GARBLE.test(raw);
  const lowerAll = raw.toLowerCase().replace(/[^a-z\s-]/g, "").trim();
  const isBackchannel = words.length <= 3 && (substWords.length === 0 || BACKCHANNEL.has(lowerAll));
  const isGarbleOnly = hasGarble && substWords.length < 3;
  const isSubstantive = !isBackchannel && substWords.length >= 3;
  return { raw, words: words.length, substWords: substWords.length, hasGarble, isBackchannel, isGarbleOnly, isSubstantive };
}

function simulate(turns, everyN, countOnlySubstantive) {
  let sinceFire = 0, fires = 0, weakFires = 0;
  const fireLog = [];
  let window = [];
  for (const t of turns) {
    const c = classify(t.text);
    const counts = countOnlySubstantive ? c.isSubstantive : true;
    if (counts) { sinceFire += 1; window.push(c); }
    if (sinceFire >= everyN) {
      fires += 1;
      const subst = window.filter((x) => x.isSubstantive).length;
      if (subst <= 1) weakFires += 1; // a fire whose window carried almost no real content
      fireLog.push({ atTurn: t.n, windowSubst: subst, windowSize: window.length });
      sinceFire = 0; window = [];
    }
  }
  return { fires, weakFires, fireLog };
}

const dir = __dirname;
const fixtures = fs.readdirSync(dir).filter((f) => /^fixture-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort();

console.log("DETERMINISM PROBE — 3-turn trigger over real (noisy) fixture dialog\n");
let totT = 0, totGarble = 0, totBack = 0, totSubst = 0;
for (const name of fixtures) {
  const fx = require(path.join(dir, name));
  const cls = fx.turns.map((t) => classify(t.text));
  const garble = cls.filter((c) => c.isGarbleOnly).length;
  const back = cls.filter((c) => c.isBackchannel).length;
  const subst = cls.filter((c) => c.isSubstantive).length;
  totT += fx.turns.length; totGarble += garble; totBack += back; totSubst += subst;

  const naive = simulate(fx.turns, 3, false);      // count every committed row
  const robust = simulate(fx.turns, 3, true);       // count only substantive turns
  console.log(`■ ${name}: ${fx.turns.length} turns  (substantive ${subst}, backchannel ${back}, garble-only ${garble})`);
  console.log(`    NAIVE  (every 3 committed rows): ${naive.fires} fires, ${naive.weakFires} weak (≤1 real turn in window)`);
  console.log(`    ROBUST (every 3 SUBSTANTIVE):    ${robust.fires} fires, ${robust.weakFires} weak`);
  // show any garble-only rows — these are the ones a robust commit layer should never commit
  const garbleRows = fx.turns.filter((t) => classify(t.text).isGarbleOnly).map((t) => `t${t.n}:"${t.text.slice(0, 50)}"`);
  if (garbleRows.length) console.log(`    garble-only rows (should NOT be committed as turns): ${garbleRows.join("  ")}`);
}
console.log(`\nTOTAL: ${totT} turns  |  substantive ${totSubst} (${Math.round((totSubst / totT) * 100)}%)  backchannel ${totBack}  garble-only ${totGarble}`);
console.log("\nTakeaway: NAIVE weak-fires + garble-only rows = the count a robust turn-commit MUST prevent");
console.log("(filter empty/partial/garble/backchannel before it becomes a countable turn) for '3 turns' to be trustworthy.");
