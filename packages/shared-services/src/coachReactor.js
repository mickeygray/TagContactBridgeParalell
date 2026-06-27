"use strict";

// THE HAIKU REACTOR — the fast per-turn tier of the two-tier coach.
//
// Fires every coachable prospect turn (real time). It is AIMED by the once-a-minute
// Opus deep pull: it reads the slim rules/objection reference, the current `steering`
// (focus + callFlow + summary + watchFor) from coachDeepPull, and the prospect's latest
// turn(s), and emits ONE short coaching line for the agent.
//
// CACHE LAYOUT (the whole point — keeps the per-turn call at pennies):
//   system = [ slim reference  +  steering (focus + summary + watchFor) ]   <- cached; refreshes ~once/min
//   prompt = [ latest turn(s) ]                                              <- volatile, per turn
// Within a minute the system is byte-stable, so every per-turn call is a warm cache read;
// the once/min steering refresh is the only (cheap) cache re-write.
//
// Pure module — builds the request + parses. The spawn is the injected runner (Haiku, no
// thinking, on a SEPARATE metered Anthropic key so the high-frequency churn never 429s the
// claude -p Max account that runs the Opus deep pull). Consumes coachDeepPull's output as `steering`.

const REACTOR_SYSTEM_HEAD = [
  "You are the live reaction layer of a sales-call coach for The Tax Group, a licensed tax-representation firm.",
  "A slower strategist set the CURRENT STRATEGY (below) ~a minute ago. Your job is to react to the prospect's LATEST turn with ONE short coaching line for the agent — follow that strategy, watch for the flagged cues, and follow the rules in the reference.",
  "Be terse: `say` is one short sentence the agent can glance at mid-call. If the latest turn hits a flagged opportunity or objection, name which in `flag`. Never promise specific outcomes.",
  "Output ONLY JSON {say, flag}.",
].join(" ");

const REACTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say"],
  properties: {
    say: { type: "string" },
    flag: { type: "string" },
  },
};

function renderSteering(steering) {
  if (!steering || typeof steering !== "object") return "(no strategy yet — react from the rules + the latest turn)";
  const lines = [];
  if (steering.focus) lines.push("FOCUS (how to handle this call right now): " + steering.focus);
  const cf = steering.callFlow || {};
  if (Array.isArray(cf.next) && cf.next.length) lines.push("NEXT: " + cf.next.join("; "));
  if (cf.phase) lines.push("PHASE: " + cf.phase);
  if (steering.summary) lines.push("CALL SO FAR: " + steering.summary);
  const wf = Array.isArray(steering.watchFor) ? steering.watchFor : [];
  if (wf.length) {
    lines.push("WATCH FOR:");
    for (const w of wf) lines.push("  - if [" + w.cue + "] -> " + (w.steer || "handle per the method"));
  }
  return lines.join("\n");
}

// buildReactorRequest({ reference, steering, recentTurns, caseContext }) -> { system, prompt, schema }.
// `reference` is the SLIM rules/objection reference (NOT the full 25K — that's the deep pull's job);
// keep it stable so the cache holds. `steering` is coachDeepPull's parsed output. `recentTurns` is the
// last few raw turns (the only volatile part). The caller is responsible for cache_control on `system`.
function buildReactorRequest({ reference, steering, recentTurns, caseContext } = {}) {
  const system = [
    REACTOR_SYSTEM_HEAD,
    "",
    "=== RULES / OBJECTIONS (reference) ===",
    String(reference || "").trim() || "(none supplied)",
    "",
    "=== CURRENT STRATEGY (refreshed ~once a minute) ===",
    renderSteering(steering),
  ].join("\n");

  const lines = [];
  if (caseContext) lines.push("Case: " + caseContext);
  lines.push("Latest prospect turn(s):");
  lines.push(String(recentTurns || "").trim() || "(empty)");
  lines.push("");
  lines.push("React with JSON {say, flag}.");
  return { system, prompt: lines.join("\n"), schema: REACTOR_SCHEMA };
}

function asStr(v) {
  return v == null ? "" : String(v).trim();
}

// parseReactor(res) -> { say, flag } | null. `say` is the live coach line for the agent.
function parseReactor(res) {
  const out = res && (res.json || (typeof res === "object" && res.ok !== false ? res : null));
  if (!out || typeof out !== "object") return null;
  const say = asStr(out.say);
  if (!say) return null;
  return { say, flag: asStr(out.flag) || undefined };
}

module.exports = { REACTOR_SYSTEM_HEAD, REACTOR_SCHEMA, buildReactorRequest, parseReactor, renderSteering };
