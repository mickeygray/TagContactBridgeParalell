"use strict";

// SUBSTANCE-FLOORED TURN ACCUMULATOR (two-station coach, 2026-07-08). The A-station
// trigger: fire every N SUBSTANTIVE turns, not every N seconds and not every STT event.
// Productionizes the exact rules the determinism eval validated (scripts/coach-eval/
// run-determinism2.js — an unfiltered commit fired ~70% more, on noise):
//
//   1. FINALS ONLY      — is_final:false partials never count (can't inflate turns)
//   2. SUBSTANCE FLOOR  — a turn needs >= MIN_WORDS real (non-backchannel) words
//   3. GARBLE DROP      — bracketed/IVR/repeated-token noise never counts
//   4. DEDUP            — the same phrase can't be committed twice in a row
//
// Pure and deterministic: the fire decision is a function of the committed transcript.
// A dropped turn is NOT lost to the coach — A's 2-3 turn window still carries it
// (a lone "No." doesn't fire the coach, but when a real turn fires, the window shows
// the "No." for judgment). Counting is speaker-agnostic by design; the runtime decides
// what it feeds.

const MIN_WORDS = 2;
const BACKCHANNEL = new Set([
  "yeah", "yes", "no", "okay", "ok", "sure", "right", "mm", "mmm", "mhm",
  "uh", "um", "uh-huh", "mm-hm", "gotcha", "correct", "exactly", "hello",
]);
const GARBLE = /\[[^\]]*\]|zz+t?|para español|press one|oprima|the the uh|the the mm|\bmmf\b|\bnnh\b/i;

function substWordCount(text) {
  const cleaned = String(text || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(GARBLE, " ")
    .replace(/[^a-z0-9'\s-]/gi, " ")
    .trim();
  const words = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  return words.filter((w) => !BACKCHANNEL.has(w.toLowerCase())).length;
}

function isGarble(text) {
  return GARBLE.test(String(text || "")) && substWordCount(text) < MIN_WORDS;
}

// Pure per-turn verdict. reason is diagnostic (fires-vs-ticks logging wants it).
function classifyTurn({ text, final = true } = {}) {
  if (!final) return { counted: false, reason: "partial" };
  const trimmed = String(text || "").trim();
  if (!trimmed) return { counted: false, reason: "empty" };
  if (isGarble(trimmed)) return { counted: false, reason: "garble" };
  if (substWordCount(trimmed) < MIN_WORDS) return { counted: false, reason: "backchannel" };
  return { counted: true, reason: "substantive" };
}

function normalizeForDedup(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function createCoachTurnAccumulator({ threshold = 3 } = {}) {
  const fireAt = Math.max(Number(threshold) || 3, 1);
  let sinceLastFire = 0;
  let totalCounted = 0;
  let totalSeen = 0;
  let lastCommitted = null;

  return {
    // Feed one STT event. Returns the verdict + whether A should fire NOW.
    commit({ speaker = null, text, final = true } = {}) {
      totalSeen += 1;
      const verdict = classifyTurn({ text, final });
      if (!verdict.counted) {
        return { ...verdict, speaker, fire: false, sinceLastFire };
      }
      const normalized = normalizeForDedup(text);
      if (normalized && normalized === lastCommitted) {
        return { counted: false, reason: "duplicate", speaker, fire: false, sinceLastFire };
      }
      lastCommitted = normalized;
      sinceLastFire += 1;
      totalCounted += 1;
      const fire = sinceLastFire >= fireAt;
      if (fire) sinceLastFire = 0;
      return { ...verdict, speaker, fire, sinceLastFire };
    },
    peek() {
      return { sinceLastFire, totalCounted, totalSeen, threshold: fireAt };
    },
    reset() {
      sinceLastFire = 0;
      lastCommitted = null;
    },
  };
}

module.exports = {
  createCoachTurnAccumulator,
  classifyTurn,
  substWordCount,
  isGarble,
  MIN_WORDS,
};
