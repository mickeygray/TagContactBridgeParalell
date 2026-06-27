"use strict";

// VERSION A — "the riff." Haiku reads the transcript with a LITTLE thinking and
// generates guidance from its OWN sales + tax-resolution knowledge. NO library, no
// skill-pull, no pre-render, no spine. The simplest possible coach.
//
// This is a capability test: is a good prompt + a capable model ENOUGH, or does the
// structured system (Version B: spine + library lookups + interview) earn its
// complexity? Run both on the same transcript and compare. Pure module: builds the
// request + parses; the spawn is the injected runner (use a small maxThinkingTokens
// for "a little thinking").

const RIFF_SYSTEM = [
  "You are a live sales-call coach for The Tax Group, a licensed tax-representation firm.",
  "Coach the agent to follow THE TAX GROUP'S APPROVED REPRESENTATION METHODOLOGY (provided below):",
  "the three factors (owed / filed / on-record), representation as a FOUNDATION (Forms 2848, 8821, state POA),",
  "the marathon framing, the payment ladder (ANCHOR FULL first, then two-month split, then four-month at $350/mo, then card on file),",
  "and the tone rules (confidence first, silence is powerful, never apologize for the fee, frame payments as structure not a discount).",
  "Use the objection mechanics and tax knowledge as support.",
  "From what the PROSPECT just said, render ONE piece of guidance for the agent:",
  "Read (what's happening) + Steer (HOW to handle it, per the methodology) + optionally Try (a short line).",
  "Steer is the point — equip the agent's judgment, not a word-for-word script.",
  "Never promise specific outcomes — the firm takes the responsible path, not big promises.",
  "Output ONLY JSON {read, steer, try}: read = what's happening, steer = how to handle it, try = optional short line. Each field one short sentence.",
].join(" ");

const RIFF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    read: { type: "string" },
    steer: { type: "string" },
    try: { type: "string" },
  },
};

function buildRiffRequest({ transcript, caseContext } = {}) {
  const lines = [];
  if (caseContext) lines.push("Case (from the agent's interview): " + caseContext);
  lines.push("Conversation so far:");
  lines.push(String(transcript || "").trim() || "(empty)");
  lines.push("Coach the agent's next move as JSON {read, steer, try}.");
  return { system: RIFF_SYSTEM, prompt: lines.join("\n"), schema: RIFF_SCHEMA };
}

function parseRiff(res) {
  const out = res && (res.json || (typeof res === "object" && !res.ok ? null : res));
  if (!out || typeof out !== "object") return null;
  const read = String(out.read || "").trim();
  const steer = String(out.steer || "").trim();
  const tryLine = String(out.try || "").trim();
  if (!read && !steer && !tryLine) return null;
  return { read, steer, try: tryLine || undefined };
}

module.exports = { RIFF_SYSTEM, RIFF_SCHEMA, buildRiffRequest, parseRiff };
