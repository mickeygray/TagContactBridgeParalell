"use strict";

// THE OPUS DEEP PULL — the slow strategic tier of the two-tier coach.
//
// Fires ~once a minute (or on a stakes-escalation) per active call. Reads the full
// approved method reference + the running transcript + the PRIOR summary/spine, and
// produces the STEERING that aims the fast Haiku per-turn reactor for the next minute:
//   focus     — how to handle THIS call right now (the strategic directive)
//   callFlow  — { accomplished[], next[], phase } (the spine, updated vs the prior)
//   summary   — the running call summary (the scribe role — also the closeout artifact)
//   watchFor  — 2-5 anticipated opportunities/objections the reactor should flag on sight
//
// This is the upgrade of the existing rollingDigest "scribe": instead of just facts +
// summary, it emits the steering the per-turn reactor consumes. Pure module — builds the
// request + parses; the spawn is the injected runner (Opus on claude -p, no thinking,
// ~once/min; the other tier — Haiku per-turn — runs on a separate metered key so the
// high-frequency churn never 429s the Max account). See coachReactor for the consumer.

const { buildReferenceBody } = require("./coachReferenceLibrary");

const DEEP_PULL_SYSTEM = [
  "You are the strategic tier of a live sales-call coach for The Tax Group, a licensed tax-representation firm.",
  "You run ~once a minute per call. You see the full method below, the running transcript, and your PRIOR summary + spine.",
  "Your job is NOT to write the live coaching line — a faster model does that every turn. Your job is to set the STRATEGY it follows for the next minute, following THE TAX GROUP METHOD (the backbone below): the three factors, representation-as-foundation (Forms 2848/8821/state POA), the marathon framing, the payment ladder (anchor full first), and the tone rules.",
  "Return ONE JSON object:",
  "1) focus — how to handle THIS call RIGHT NOW: the single strategic directive the live reactor should follow (one or two sentences). Ground it in where the call actually is.",
  "2) callFlow — {accomplished: [objective things that have genuinely happened], next: [the 1-3 things to accomplish next], phase: the current call phase}. Build accomplished by updating the PRIOR spine; never list what didn't happen.",
  "3) summary — a tight running summary of the call so far (this doubles as the closeout record). Update the PRIOR summary; keep it factual and brief.",
  "4) watchFor — 2-5 things likely to come up NEXT, each {cue: what the prospect might say, steer: how the reactor should handle it}.",
  "Never promise specific outcomes. Be terse. Output ONLY the JSON object.",
  "",
  "=== REFERENCE ===",
  buildReferenceBody(),
].join("\n");

const DEEP_PULL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["focus", "callFlow", "summary"],
  properties: {
    focus: { type: "string" },
    callFlow: {
      type: "object",
      additionalProperties: false,
      required: ["accomplished", "next"],
      properties: {
        accomplished: { type: "array", items: { type: "string" } },
        next: { type: "array", items: { type: "string" } },
        phase: { type: "string" },
      },
    },
    summary: { type: "string" },
    watchFor: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cue"],
        properties: { cue: { type: "string" }, steer: { type: "string" } },
      },
    },
  },
};

function summarizePrior(priorSummary, priorSpine) {
  const lines = [];
  lines.push("PRIOR summary: " + (String(priorSummary || "").trim() || "(none yet — start of call)"));
  const done = priorSpine && Array.isArray(priorSpine.accomplished) ? priorSpine.accomplished : [];
  const next = priorSpine && Array.isArray(priorSpine.next) ? priorSpine.next : [];
  lines.push("PRIOR spine — accomplished: " + (done.length ? done.join("; ") : "(nothing yet)"));
  lines.push("PRIOR spine — next: " + (next.length ? next.join("; ") : "(unset)"));
  if (priorSpine && priorSpine.phase) lines.push("PRIOR phase: " + priorSpine.phase);
  return lines.join("\n");
}

// buildDeepPullRequest({ transcript, priorSummary, priorSpine, caseContext }) -> { system, prompt, schema }.
// The SYSTEM (reference) is the stable cached prefix; the prompt carries the volatile per-call state.
function buildDeepPullRequest({ transcript, priorSummary, priorSpine, caseContext } = {}) {
  const lines = [];
  if (caseContext) lines.push("Case (from the agent's interview): " + caseContext);
  lines.push(summarizePrior(priorSummary, priorSpine));
  lines.push("");
  lines.push("Full conversation so far:");
  lines.push(String(transcript || "").trim() || "(empty)");
  lines.push("");
  lines.push("Return the JSON {focus, callFlow, summary, watchFor}.");
  return { system: DEEP_PULL_SYSTEM, prompt: lines.join("\n"), schema: DEEP_PULL_SCHEMA };
}

function asStr(v) {
  return v == null ? "" : String(v).trim();
}

// parseDeepPull(res) -> the steering object { focus, callFlow, summary, watchFor } | null.
// Shape is exactly what coachReactor.buildReactorRequest consumes as `steering`.
function parseDeepPull(res) {
  const out = res && (res.json || (typeof res === "object" && res.ok !== false ? res : null));
  if (!out || typeof out !== "object") return null;
  const focus = asStr(out.focus);
  const summary = asStr(out.summary);
  const cf = out.callFlow || {};
  const callFlow = {
    accomplished: Array.isArray(cf.accomplished) ? cf.accomplished.map(asStr).filter(Boolean) : [],
    next: Array.isArray(cf.next) ? cf.next.map(asStr).filter(Boolean) : [],
    phase: asStr(cf.phase) || undefined,
  };
  if (!focus && !summary && !callFlow.accomplished.length && !callFlow.next.length) return null;
  const watchFor = Array.isArray(out.watchFor)
    ? out.watchFor.filter((w) => w && w.cue).map((w) => ({ cue: asStr(w.cue), steer: asStr(w.steer) || undefined }))
    : [];
  return { focus, callFlow, summary, watchFor };
}

module.exports = { DEEP_PULL_SYSTEM, DEEP_PULL_SCHEMA, buildDeepPullRequest, parseDeepPull, summarizePrior };
