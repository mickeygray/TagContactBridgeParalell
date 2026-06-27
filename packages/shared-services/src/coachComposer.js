"use strict";

// The COMPOSER seat (Haiku, ephemeral spawn). Given the prospect's turn + the
// recalled candidate guidance + a compact state, it renders ONE feedback item
// (Read/Steer/Try) or WAITs. It is a RENDER seat, not a judgment seat — the probes
// showed Haiku renders supplied content faithfully but confabulates judgment, so
// COMPLIANCE/DNC is a deterministic backstop here (checkCompliance), never Haiku's
// call. This module is pure: it builds the request + parses the result; the actual
// spawn is the injected runner.

const COMPOSER_KINDS = ["nudge", "objection", "opportunity"];

// The schema the composer fills (claude -p has no native schema arg; the runner
// instructs the model to match this and we validate on the way back).
const COMPOSER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["compose", "wait"] },
    kind: { type: "string", enum: COMPOSER_KINDS },
    severity: { type: "string", enum: ["info", "warn"] },
    read: { type: "string" },
    steer: { type: "string" },
    try: { type: "string" },
    priority: { type: "number" },
  },
};

const COMPOSER_SYSTEM = [
  "You are a live sales-call coach for a tax-resolution firm (WYNN).",
  "From what the PROSPECT just said, render ONE piece of guidance for the agent:",
  "Read (what's happening) + Steer (what to do) + optionally Try (a short line to say).",
  "Most turns are Read+Steer; include Try only when a specific line genuinely helps.",
  "If the turn is noise, filler, or nothing to coach, return {\"action\":\"wait\"}.",
  "Never promise specific outcomes (no settlement guarantees). Stay the calm expert.",
  "BREVITY IS MANDATORY: read, steer, and try are EACH one short sentence (max ~18 words); the whole JSON under 55 words. A long nudge is useless on a live line.",
].join(" ");

// buildComposerRequest -> { system, prompt, schema } for the runner to spawn.
// `system` defaults to the generalist contract; the orchestrator passes a
// phase-specialized system (selectComposerSystem) so the spawn is a "specific Haiku
// for a specific task."
function buildComposerRequest({ turn, candidates = [], state = {}, system = COMPOSER_SYSTEM } = {}) {
  const lines = [];
  lines.push(`Phase: ${state.phase || "unknown"}`);
  if (Array.isArray(state.captured) && state.captured.length) lines.push(`Already known: ${state.captured.join(", ")}`);
  if (state.caseContext) lines.push(`Case (from the agent's interview): ${state.caseContext}`);
  lines.push(`Prospect just said: "${String((turn && turn.text) || "").trim()}"`);
  if (candidates.length) {
    lines.push("Relevant guidance (pick the most fitting; render it in your own words, don't quote):");
    for (const c of candidates) lines.push(`- ${c.label || c.key}: ${c.guidance || c.steer || c.reframe || ""}`);
  }
  lines.push('Respond as JSON only: {"action":"compose"|"wait","kind","severity","read","steer","try"?}.');
  return { system, prompt: lines.join("\n"), schema: COMPOSER_OUTPUT_SCHEMA };
}

// parseComposerResult(runnerResult, ctx) -> a feedback item, or null (WAIT/empty).
function parseComposerResult(res, ctx = {}) {
  const out = res && (res.json || res.parsed || (typeof res === "object" && !res.ok ? null : res));
  if (!out || typeof out !== "object") return null;
  if (out.action === "wait") return null;
  const read = String(out.read || "").trim();
  const steer = String(out.steer || "").trim();
  const tryLine = String(out.try || "").trim();
  if (!read && !steer && !tryLine) return null; // no content => treat as WAIT
  const kind = COMPOSER_KINDS.includes(out.kind) ? out.kind : "nudge";
  const severity = out.severity === "warn" ? "warn" : "info";
  return {
    id: ctx.id || `c${ctx.at || 0}`,
    kind,
    severity,
    read,
    steer,
    try: tryLine || undefined,
    priority: Number.isFinite(out.priority) ? out.priority : 0,
    at: Number(ctx.at) || 0,
    ttlMs: Number.isFinite(ctx.ttlMs) ? ctx.ttlMs : 20000,
    source: "composer",
  };
}

// Deterministic DNC / compliance backstop — NEVER Haiku's call. Over-triggers on
// purpose: a false alarm is cheap, a missed revocation is catastrophic.
const DNC_PATTERNS = [
  /\bstop calling\b/i,
  /\btake me off\b/i,
  /\bdo ?n'?t call\b/i,
  /\bremove me\b/i,
  /\bunsubscribe\b/i,
  /\bquit calling\b/i,
  /\bnever call (me|again)\b/i,
  /\bput me on (your )?(the )?do not call\b/i,
];

function checkCompliance(turn) {
  const text = String((turn && turn.text) || "");
  if (DNC_PATTERNS.some((re) => re.test(text))) {
    return { severity: "block", message: "DNC requested — stop pitching, confirm you'll remove them, end politely." };
  }
  return null;
}

module.exports = {
  COMPOSER_KINDS,
  COMPOSER_OUTPUT_SCHEMA,
  COMPOSER_SYSTEM,
  buildComposerRequest,
  parseComposerResult,
  checkCompliance,
  DNC_PATTERNS,
};
