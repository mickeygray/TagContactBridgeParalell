"use strict";

// The warm ORCHESTRATOR — a long-running process (no model, so warm is trivial:
// it's just node holding state). Per transcript turn it runs the pure spine
// (extractor -> phase machine -> passive checklists), decides whether the moment is
// coachable, and if so SPAWNS an ephemeral Haiku composer (the injected runner) to
// render one feedback item. Compliance/skip-beat reminders are materialized
// deterministically here (off the Haiku path). It then merges the item into the ONE
// feedback channel and recomputes the render mode.
//
// The runner is the single live seam: inject a fake -> the whole loop is offline
// testable; inject the real `claude -p` Haiku runner -> it actually spawns.

const { extractTurnSignals, extractCapturedFacts } = require("./coachSignalExtractor");
const { reduceCoachPhase, orderOf, phaseDefinition } = require("./coachPhaseMachine");
const { recognizeSteps, stepChecklist } = require("./coachPhaseSteps");
const { normalizeCoachState, applyGuideDelta, selectMode, isFeedbackLive } = require("./coachState");
const { buildComposerRequest, parseComposerResult, checkCompliance } = require("./coachComposer");
const { pullSkill } = require("./coachSkills");
const { deterministicClean } = require("./coachTranscript");

const DISCOVERY_LABELS = {
  balance: "Balance owed",
  unfiled_years: "Unfiled years",
  collection_status: "Collection status",
  income_type: "Income type",
  ability_to_pay: "Ability to pay",
};

function isAgentTurn(turn) {
  return String((turn && turn.role) || "").toLowerCase() === "agent";
}

// Default gate: the composer renders to PROSPECT substance; agent turns drive phase
// only (never a spawn). A substantive prospect turn is >= 3 words.
function defaultShouldCompose(turn) {
  if (isAgentTurn(turn)) return false;
  const words = String((turn && turn.text) || "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 3;
}

function createCoachOrchestrator(deps = {}) {
  const {
    runner, // async (req) => { ok, json } — the ONE live seam (fake or claude -p Haiku)
    recall = () => [], // (turn, ctx) => candidate guidance[] (over-inclusive; injectable)
    shouldCompose = defaultShouldCompose,
    complianceCheck = checkCompliance,
    now = () => 0, // injectable clock (production: () => Date.now())
    ttlMs = 20000,
    session = null,
  } = deps;

  let state = normalizeCoachState({ session });
  let phaseState; // undefined seed -> reduceCoachPhase cold-starts at intro
  const captured = new Set(); // prospect DiscoveryItem facts (sticky)
  const completedSteps = new Set(); // recognized beats ∪ captured facts (passive checklist)
  let turnIndex = -1;

  function projectPhase() {
    const id = (phaseState && phaseState.phase) || "intro";
    const def = phaseDefinition(id) || {};
    return {
      current: id,
      order: orderOf(id),
      advanceGoal: def.advanceGoal || "",
      since: (phaseState && phaseState.since) || 0,
      steps: stepChecklist(id, completedSteps), // PASSIVE: checkmarks only
    };
  }

  function discoverySlice() {
    const ids = Object.keys(DISCOVERY_LABELS);
    return {
      items: ids.map((id) => ({ id, label: DISCOVERY_LABELS[id], captured: captured.has(id) })),
      missing: ids.filter((id) => !captured.has(id)),
    };
  }

  // Build the next channel: keep still-live items (block/critical always), then let a
  // fresh item supersede the prior NON-blocking items (one live nudge at a time).
  function buildChannel(existing, addition, t) {
    const kept = (existing || []).filter(
      (it) => it && (it.severity === "block" || it.severity === "critical" || isFeedbackLive(it, t))
    );
    if (!addition) return kept;
    const blockingKept = kept.filter((it) => it.severity === "block" || it.severity === "critical");
    return [...blockingKept.filter((it) => it.id !== addition.id), addition];
  }

  async function ingestTurn(turn) {
    turnIndex += 1;
    const t = now();

    // Normalization layer: deterministic light-clean on the live path (instant);
    // the original is kept on `.raw` for display. Translation belongs in the STT;
    // any heavier corrector runs OFF this path (display/grading), never blocking.
    const rawText = turn && turn.text;
    turn = { ...turn, text: deterministicClean(rawText), raw: rawText };

    // 1. pure signal extraction (sticky)
    for (const id of extractCapturedFacts(turn)) {
      captured.add(id);
      completedSteps.add(id);
    }
    for (const id of recognizeSteps(turn)) completedSteps.add(id);

    // 2. phase machine
    const signals = { ...extractTurnSignals(turn), capturedFacts: [...captured], turnCount: turnIndex };
    phaseState = reduceCoachPhase(phaseState, signals).state;

    // 3. decide the live feedback item for this turn
    let item = null;
    let spawned = false;
    const flag = complianceCheck(turn);
    if (flag) {
      // deterministic hard interrupt — never a model call
      item = {
        id: `dnc${t}`,
        kind: "compliance",
        severity: flag.severity || "block",
        read: flag.message,
        steer: flag.message,
        at: t,
        ttlMs: Number.POSITIVE_INFINITY, // present until explicitly cleared
        source: "complianceGate",
      };
    } else if (shouldCompose(turn, state)) {
      const ctx = { phase: phaseState && phaseState.phase, captured: [...captured] };
      // Pull the near-complete prompt: phase doctrine (always) + the matched
      // situation's overcoming strategy from the bank. ~90% pre-written; the spawn
      // only adds the transcription. Falls back to the phase doctrine on a miss.
      const pulled = pullSkill({ turn, phase: ctx.phase });
      const req = buildComposerRequest({ turn, candidates: recall(turn, ctx), state: ctx, system: pulled.system });
      const res = runner ? await runner(req) : null;
      item = parseComposerResult(res, { id: `c${t}`, at: t, ttlMs });
      if (item) item.skillKeys = pulled.skillKeys; // provenance: which skill fired
      spawned = true;
    }

    // 4. merge into the ONE channel, apply the rev-ordered delta, recompute mode
    const nextFeedback = buildChannel(state.feedback, item, t);
    state = applyGuideDelta(state, {
      rev: state.rev + 1,
      phase: projectPhase(),
      discovery: discoverySlice(),
      feedback: nextFeedback,
    });
    state = { ...state, mode: selectMode(state, { now: t }) };

    return { state, mode: state.mode, spawned, item };
  }

  return {
    ingestTurn,
    snapshot: () => state,
    get phase() {
      return (phaseState && phaseState.phase) || "intro";
    },
  };
}

module.exports = { createCoachOrchestrator, defaultShouldCompose };
