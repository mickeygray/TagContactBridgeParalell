"use strict";

// THE UNIFIED COACH — one call does everything.
//
// Fed the full conversation + the reference method + the PRIOR call-spine, it returns
// ONE structured object:
//   guidance  — focus on the last few turns: the real-time read/steer/try (what to do NOW)
//   spine     — { accomplished[], next[], phase } updated against the prior spine
//   packets   — 3-5 anticipated coaching bubbles {cue, read, steer, try} the agent picks from
//
// This consolidates the separate reaction / navigator / pre-render calls into a single
// pass (one model produced it, so the parts are mutually consistent). Transcript
// cleanup stays a SEPARATE off-path Haiku job (outputting the whole cleaned transcript
// here would scale output with call length). Pure module: builds the request + parses;
// the spawn is the injected runner (Opus fast, 0 thinking, is the proven live config).

const { buildReferenceBody } = require("./coachReferenceLibrary");

const UNIFIED_SYSTEM = [
  "You are the live sales-call coach for The Tax Group, a licensed tax-representation firm.",
  "You receive the full conversation, the PRIOR call-spine, and the approved method + tactics + objections + tax reference below.",
  "Coach the agent to follow THE TAX GROUP METHOD (the backbone below) — the three factors, representation as a FOUNDATION (Forms 2848/8821/state POA), the marathon framing, the payment ladder (anchor full first), and the tone rules.",
  "Return ONE JSON object with three parts:",
  "1) guidance — focus on the LAST FEW TURNS: the immediate {read, steer, try}. read = what's happening; steer = HOW to handle it per the method; try = optional short line. Each one short sentence.",
  "2) spine — {accomplished: [objective things that have genuinely happened so far], next: [the 1-3 things to accomplish next], phase: the current call phase}. Build accomplished by updating the PRIOR spine; never list anything that didn't actually happen.",
  "3) packets — 3-5 coaching moments likely to come up NEXT, each a ready bubble {cue: what the prospect might say, read, steer, try} the agent can pick from instantly.",
  "Never promise specific outcomes. Be terse. Output ONLY the JSON object.",
  "",
  "=== REFERENCE ===",
  buildReferenceBody(),
].join("\n");

const UNIFIED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["guidance", "spine"],
  properties: {
    guidance: {
      type: "object",
      additionalProperties: false,
      properties: { read: { type: "string" }, steer: { type: "string" }, try: { type: "string" } },
    },
    spine: {
      type: "object",
      additionalProperties: false,
      required: ["accomplished", "next"],
      properties: {
        accomplished: { type: "array", items: { type: "string" } },
        next: { type: "array", items: { type: "string" } },
        phase: { type: "string" },
      },
    },
    packets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cue"],
        properties: {
          cue: { type: "string" },
          read: { type: "string" },
          steer: { type: "string" },
          try: { type: "string" },
        },
      },
    },
  },
};

function summarizeSpine(spine) {
  if (!spine || typeof spine !== "object") return "(none yet — start of call)";
  const done = Array.isArray(spine.accomplished) ? spine.accomplished : [];
  const next = Array.isArray(spine.next) ? spine.next : [];
  return [
    "accomplished: " + (done.length ? done.join("; ") : "(nothing yet)"),
    "next: " + (next.length ? next.join("; ") : "(unset)"),
    spine.phase ? "phase: " + spine.phase : "",
  ].filter(Boolean).join("\n");
}

// buildUnifiedRequest({ transcript, priorSpine, caseContext }) -> { system, prompt, schema }.
function buildUnifiedRequest({ transcript, priorSpine, caseContext } = {}) {
  const lines = [];
  if (caseContext) lines.push("Case (from the agent's interview): " + caseContext);
  lines.push("PRIOR call-spine (your last check of what's been accomplished):");
  lines.push(summarizeSpine(priorSpine));
  lines.push("");
  lines.push("Full conversation so far (focus your guidance on the LAST FEW turns):");
  lines.push(String(transcript || "").trim() || "(empty)");
  lines.push("");
  lines.push("Return the JSON {guidance, spine, packets}.");
  return { system: UNIFIED_SYSTEM, prompt: lines.join("\n"), schema: UNIFIED_SCHEMA };
}

function asStr(v) {
  return v == null ? "" : String(v).trim();
}

// parseUnifiedResult(res) -> { guidance, spine, packets } | null.
function parseUnifiedResult(res) {
  const out = res && (res.json || (typeof res === "object" && !res.ok ? null : res));
  if (!out || typeof out !== "object") return null;
  const g = out.guidance || {};
  const s = out.spine || {};
  const guidance = { read: asStr(g.read), steer: asStr(g.steer), try: asStr(g.try) || undefined };
  if (!guidance.read && !guidance.steer && !guidance.try) return null;
  const spine = {
    accomplished: Array.isArray(s.accomplished) ? s.accomplished.map(asStr).filter(Boolean) : [],
    next: Array.isArray(s.next) ? s.next.map(asStr).filter(Boolean) : [],
    phase: asStr(s.phase) || undefined,
  };
  const packets = Array.isArray(out.packets)
    ? out.packets
        .filter((p) => p && p.cue)
        .map((p, i) => ({ id: "pkt" + i, cue: asStr(p.cue), read: asStr(p.read), steer: asStr(p.steer), try: asStr(p.try) || undefined }))
    : [];
  return { guidance, spine, packets };
}

module.exports = { UNIFIED_SYSTEM, UNIFIED_SCHEMA, buildUnifiedRequest, parseUnifiedResult, summarizeSpine };
