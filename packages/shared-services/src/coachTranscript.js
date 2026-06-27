"use strict";

// Transcript normalization — the layer between STT and the coach.
//
// Two jobs: TRANSLATE (non-English -> English) and CORRECT (STT errors / grammar).
//
// LATENCY PRINCIPLE: never put a BLOCKING model call here on the live path — it
// would double the ~5-6s nudge (clean ~5s + compose ~5s = ~11s). So:
//   - TRANSLATE belongs in the STT (OpenAI transcribe translate-mode -> English),
//     not here. Free, no extra call.
//   - The live models (Haiku composer, Sonnet pick) are ROBUST to messy text, so
//     the live nudge does NOT need a clean transcript. Only the deterministic
//     keyword PULL is brittle — and that's covered by the Sonnet override + phase
//     fallback.
//   - This seam does a fast DETERMINISTIC light-clean (safe, ~free) on the path,
//     and exposes an INJECTABLE `corrector` for a heavier/translate pass that the
//     caller runs OFF the live path (display, grading) — never blocking the nudge.

const { groundDomain } = require("./coachDomainVocab");

// Known STT mis-hears live here, grown from the real floor corpus (the STT word
// blacklists / observed garbles). Kept empty-by-default so we never ship invented
// fixups — populate from actual transcripts.
const STT_FIXUPS = [
  // [/\bexact observed garble\b/gi, "correct text"],
];

// deterministicClean(text) -> tidy text. Safe universal normalization only
// (whitespace, trim, the conservative domain grounding from coachDomainVocab, known
// fixups). Synchronous, ~free, runs on the live path — the deeper cleaning is async.
function deterministicClean(text) {
  let t = groundDomain(String(text || "").replace(/\s+/g, " ").trim());
  for (const [re, sub] of STT_FIXUPS) t = t.replace(re, sub);
  return t;
}

// normalizeTurn(turn, { corrector }) -> Promise<turn'>.
// Always sets `.text` to the cleaned text and preserves the original on `.raw`.
// If a `corrector` (async: translate / heavier grammar pass) is injected, its
// output wins — but the CALLER decides whether to run it on-path or off-path. The
// default (no corrector) is deterministic-only and instant.
async function normalizeTurn(turn = {}, { corrector } = {}) {
  const raw = turn && turn.text;
  const cleaned = deterministicClean(raw);
  if (typeof corrector === "function") {
    try {
      const out = await corrector({ ...turn, text: cleaned });
      const text = out && typeof out.text === "string" && out.text.trim() ? out.text : cleaned;
      return { ...turn, text, raw };
    } catch (_) {
      return { ...turn, text: cleaned, raw };
    }
  }
  return { ...turn, text: cleaned, raw };
}

module.exports = { normalizeTurn, deterministicClean, STT_FIXUPS };
