"use strict";

// Domain vocabulary bank — the small set of tax + company terms that grounds the
// coach in "this is a tax-resolution sales call." Used POST-TRANSCRIPTION only:
//   1. LIVE composer priming — Haiku is told to read GENUINELY garbled transcription
//      as the most likely DOMAIN term. Zero latency: rides the cached system prompt;
//      the model interprets the existing text, it does not transcribe.
//   2. ASYNC cleaner — conservative find-and-replace of known garbles into the
//      canonical term, OFF the live path, building a cleaner transcript that
//      refreshes the call path every few minutes (the live transcript isn't shown).
//
// ⚠️ NEVER feed this to the STT as a transcription primer. Priming the TRANSCRIBER
// with domain words causes PHANTOM / ECHO transcripts — the STT inserts primer terms
// that were never spoken (the self-matching-junk problem). Grounding must happen
// AFTER transcription (composer reads + interprets; cleaner find-replaces), never as
// STT input. (The bridge's existing STT primer is a separate live concern with its
// own echo-detector mitigation; this bank is not for that.)

const TAX_TERMS = [
  "IRS", "levy", "lien", "wage garnishment", "garnishment", "back taxes",
  "unfiled returns", "penalty abatement", "installment agreement",
  "offer in compromise", "OIC", "currently not collectible", "CNC",
  "Power of Attorney", "Form 2848", "Form 8821", "CP504", "CP14", "LT11",
  "revenue officer", "payroll tax", "941", "audit", "transcript",
];

const COMPANY_TERMS = ["Wynn Tax", "Wynn", "Tax Advocate Group"];

// LIVE priming block appended to the composer system. No latency — it grounds
// garbles in the model itself rather than pre-cleaning the text.
const DOMAIN_PRIMER = [
  "DOMAIN: This is a live tax-resolution sales call for Wynn Tax.",
  "The prospect's speech is transcribed live and may be garbled or mis-heard —",
  "when a word sounds odd or out of place, interpret it as the most likely tax /",
  "IRS-collections term, NOT literally. Lean on this vocabulary:",
  TAX_TERMS.join(", ") + ".",
  "The firm is Wynn Tax (a.k.a. Wynn).",
  "Only re-interpret words that are CLEARLY garbled — never force a plain, ordinary word into a tax term.",
].join(" ");

// Safe, high-confidence normalizations for the async cleaner. The company name is
// the most reliable garble; notice codes + form numbers just normalize spacing.
// Kept CONSERVATIVE so we never "correct" a real word into a domain term — the
// broader mis-hear map grows from the actual STT corpus.
const NAME_NORMALIZATIONS = [
  [/\b(win|when|wind|wynne|gwen)\s+tax\b/gi, "Wynn Tax"],
  [/\bc\.?\s?p\.?\s?(\d{2,4})\b/gi, "CP$1"],
  [/\bl\.?\s?t\.?\s?11\b/gi, "LT11"],
  [/\bform\s+28\s?48\b/gi, "Form 2848"],
];

// groundDomain(text) -> text with the safe normalizations applied. Cheap +
// deterministic; usable on the live path (helps the keyword pull match Wynn / CP
// terms) and as the seed of the async cleaner.
function groundDomain(text) {
  let t = String(text || "");
  for (const [re, sub] of NAME_NORMALIZATIONS) t = t.replace(re, sub);
  return t;
}

module.exports = { TAX_TERMS, COMPANY_TERMS, DOMAIN_PRIMER, NAME_NORMALIZATIONS, groundDomain };
