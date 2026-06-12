"use strict";

// resolutionPitchVerdict — extract the machine-parsed ```verdict fence the
// pitch designer appends to every reply (see resolutionPitchDoctrine.md
// "Output contract"). Best-effort by design: a malformed fence degrades to
// verdict:null while the prose reply still reaches the EA.

const VERDICT_CLASSES = new Set(["PITCH_NOW", "DEVELOP", "NURTURE", "PASS"]);

function parsePitchVerdict(text) {
  const raw = String(text || "");
  // Last fence wins — the model revises the verdict as the thread evolves.
  const fences = [...raw.matchAll(/```verdict\s*\n([\s\S]*?)```/g)];
  const fence = fences.length ? fences[fences.length - 1] : null;
  if (!fence) return { reply: raw.trim(), verdict: null };

  // Reply = prose with every verdict fence stripped (the UI renders the
  // verdict as a card, not as a code block).
  const reply = raw.replace(/```verdict\s*\n[\s\S]*?```/g, "").trim();

  let verdict = null;
  try {
    const parsed = JSON.parse(fence[1]);
    if (parsed && typeof parsed === "object" && VERDICT_CLASSES.has(parsed.class)) {
      verdict = {
        class: parsed.class,
        headline: String(parsed.headline || "").slice(0, 160),
        plays: Array.isArray(parsed.plays) ? parsed.plays.map((p) => String(p).slice(0, 80)).slice(0, 8) : [],
        angle: String(parsed.angle || "").slice(0, 280),
        fee: parsed.fee && typeof parsed.fee === "object"
          ? {
            low: Number.isFinite(Number(parsed.fee.low)) ? Number(parsed.fee.low) : null,
            high: Number.isFinite(Number(parsed.fee.high)) ? Number(parsed.fee.high) : null,
            monthly: Number.isFinite(Number(parsed.fee.monthly)) ? Number(parsed.fee.monthly) : null,
            path: String(parsed.fee.path || "").slice(0, 160) || null,
          }
          : null,
        clocks: Array.isArray(parsed.clocks)
          ? parsed.clocks
            .filter((c) => c && typeof c === "object")
            .map((c) => ({ what: String(c.what || "").slice(0, 120), by: String(c.by || "").slice(0, 60) }))
            .slice(0, 6)
          : [],
        missingDocs: Array.isArray(parsed.missingDocs)
          ? parsed.missingDocs.map((d) => String(d).slice(0, 80)).slice(0, 10)
          : [],
        citations: Array.isArray(parsed.citations)
          ? parsed.citations.map((c) => String(c).slice(0, 60)).slice(0, 20)
          : [],
        at: new Date(),
      };
    }
  } catch {
    // Malformed JSON: keep verdict null, prose still flows.
  }
  return { reply, verdict };
}

module.exports = { parsePitchVerdict, VERDICT_CLASSES };
