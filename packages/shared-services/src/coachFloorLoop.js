"use strict";

/**
 * coachFloorLoop — the pure orchestrator brain for the whole-floor batch coach.
 *
 * It owns NO transport, NO bus state, NO timers of its own beyond what's injected.
 * Every bus-coupled dependency is passed in, so the whole tick cycle is testable
 * offline with fakes. The bus attaches this loop with real deps (the in-process
 * builders, the injected model transports, an emit adapter, the steering writeback)
 * and drives start/stop on its lifecycle.
 *
 * Two cadences on one contract (coachBatchRunner):
 *   REACTOR (cheap, fast):  buildChanges(cursor) -> gate -> runReactor -> dispatch -> emit
 *   DEEP    (slow clock):   buildBatch()         -> gate -> runDeep    -> applySteering + dispatch -> emit
 *
 * Safety baked in: the firing gate (no active calls => no model), an in-flight
 * guard per cadence (a slow pass never overlaps the next tick), a cursor that
 * advances only after an accepted+dispatched pass (so a transient model failure
 * retries rather than dropping changes), and every tick wrapped so it can never
 * throw out of a timer.
 */

const {
  DEEP_PULL,
  REACTOR,
  buildBatchGuidanceRequest,
  parseBatchGuidance,
  shouldFireCoach,
  reduceDeepPullSteering,
} = require("./coachBatchRunner");

// The rolling-summary pure pipeline (sidecar SUMMARY cadence). Like coachBatchRunner
// above, these are sibling pure modules the loop drives; only the transport (runSummary),
// the active-batch source (buildSummaryBatch) and the session writeback (applySummary)
// are injected.
const {
  buildRollingSummaryBatchRequest,
  buildRollingSummaryPrompt,
  parseRollingSummaryResult,
  buildRollingSummaryApplyPlan,
  buildRollingSummaryCursorFromApplyPlan,
} = require("./liveCoachRollingSummaryService");

function createCoachFloorLoop(deps = {}) {
  const {
    // bus-coupled inputs (injected)
    buildChanges, // (input:{...batchOptions, cursor}) => changeSet
    buildBatch, // (input:{...batchOptions}) => batch
    buildDispatchPlan, // (activeBatch, response) => { dispatches[], rejectedCount }
    emitGuidance, // (dispatch) => void  (the bus emit adapter)
    runReactor = null, // async (req) => res | null  (Haiku transport; null => reactor off)
    runDeep = null, // async (req) => res | null  (Opus transport; null => deep off)
    applySteering = () => {}, // (updates[]) => void  (writes session.callStrategy + cockpit)
    // SUMMARY cadence (sidecar): the rolling semantic summary. Off unless all three present.
    buildSummaryBatch = null, // (input) => activeBatch  (which sessions to summarize)
    runSummary = null, // async (req) => res | null  (Codex/api substrate; null => summary off)
    applySummary = () => {}, // (applyPlan) => void  (writes session.latest/memory.rollingSummary)
    // config
    reference = "",
    batchOptions = {},
    reactorIntervalMs = 4000,
    deepIntervalMs = 60000,
    summaryIntervalMs = 120000,
    // injected scheduler (bus passes setInterval+unref; tests drive ticks by hand)
    startInterval = null, // (fn, ms) => handle
    stopInterval = null, // (handle) => void
    logger = null,
    onTick = null, // test/observability hook
  } = deps;

  let cursor = null;
  let summaryCursor = null;
  let reactorInFlight = false;
  let deepInFlight = false;
  let summaryInFlight = false;
  let reactorHandle = null;
  let deepHandle = null;
  let summaryHandle = null;
  let running = false;

  function log(level, msg, data) {
    if (logger && typeof logger[level] === "function") logger[level](msg, data);
  }

  function emitDispatches(activeBatch, parsed, tier) {
    const plan = buildDispatchPlan(activeBatch, parsed) || {};
    const dispatches = Array.isArray(plan.dispatches) ? plan.dispatches : [];
    let emitted = 0;
    for (const dispatch of dispatches) {
      try {
        emitGuidance(dispatch);
        emitted += 1;
      } catch (error) {
        log("warn", "coach_floor.emit_error", { tier, error: error.message });
      }
    }
    return { dispatchCount: dispatches.length, emitted, rejectedCount: plan.rejectedCount || 0 };
  }

  function modelFailure(res) {
    return !res || (typeof res === "object" && res.ok === false);
  }

  function modelFailureMessage(res) {
    return res && typeof res === "object" && res.error ? String(res.error) : "model-returned-empty";
  }

  async function tickReactor() {
    if (reactorInFlight) return { tier: "reactor", skipped: "in-flight" };
    reactorInFlight = true;
    try {
      const changes = buildChanges({ ...batchOptions, cursor });
      const gate = shouldFireCoach(changes, { tier: REACTOR });
      if (!gate.fire) {
        cursor = changes?.cursor ?? cursor; // no changes => safe to advance
        const out = { tier: "reactor", fired: false, reason: gate.reason };
        if (onTick) onTick(out);
        return out;
      }
      if (!runReactor) {
        const out = { tier: "reactor", fired: false, reason: "no-runner" };
        if (onTick) onTick(out);
        return out; // do NOT advance cursor: changes stay pending until a runner exists
      }
      const req = buildBatchGuidanceRequest(changes, { tier: REACTOR, reference });
      const res = await runReactor(req);
      if (modelFailure(res)) {
        const out = { tier: "reactor", fired: false, reason: "model-failed", error: modelFailureMessage(res) };
        if (onTick) onTick(out);
        return out;
      }
      const parsed = parseBatchGuidance(res, { tier: REACTOR, generatedAt: changes.generatedAt });
      const activeBatch = { conversations: changes.changedConversations || [] };
      const result = emitDispatches(activeBatch, parsed, "reactor");
      cursor = changes?.cursor ?? cursor; // advance only after accepted + dispatched
      const out = { tier: "reactor", fired: true, ...result };
      if (onTick) onTick(out);
      return out;
    } catch (error) {
      log("warn", "coach_floor.reactor_error", { error: error.message });
      return { tier: "reactor", fired: false, error: error.message }; // cursor NOT advanced => retry next tick
    } finally {
      reactorInFlight = false;
    }
  }

  async function tickDeep() {
    if (deepInFlight) return { tier: "deep", skipped: "in-flight" };
    deepInFlight = true;
    try {
      const batch = buildBatch({ ...batchOptions });
      const gate = shouldFireCoach(batch, { tier: DEEP_PULL });
      if (!gate.fire) {
        const out = { tier: "deep", fired: false, reason: gate.reason };
        if (onTick) onTick(out);
        return out;
      }
      if (!runDeep) {
        const out = { tier: "deep", fired: false, reason: "no-runner" };
        if (onTick) onTick(out);
        return out;
      }
      const req = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference });
      const res = await runDeep(req);
      if (modelFailure(res)) {
        const out = { tier: "deep", fired: false, reason: "model-failed", error: modelFailureMessage(res) };
        if (onTick) onTick(out);
        return out;
      }
      const parsed = parseBatchGuidance(res, { tier: DEEP_PULL, generatedAt: batch.generatedAt });
      // The deep pull produces cockpit STATE (currentSection/beats/remember/says/priorFlags),
      // not a live dialog dispatch — apply it to session state, do not emit. The reactor
      // owns the live say that goes through the dispatch plan.
      const updates = reduceDeepPullSteering(parsed);
      try {
        applySteering(updates);
      } catch (error) {
        log("warn", "coach_floor.steering_error", { error: error.message });
      }
      const out = { tier: "deep", fired: true, stateUpdates: updates.length };
      if (onTick) onTick(out);
      return out;
    } catch (error) {
      log("warn", "coach_floor.deep_error", { error: error.message });
      return { tier: "deep", fired: false, error: error.message };
    } finally {
      deepInFlight = false;
    }
  }

  // SUMMARY cadence (slowest clock). Builds the rolling-summary batch over the active
  // calls, runs it on the injected substrate, applies the per-session writeback, and
  // advances the summary cursor ONLY after a clean apply (so a transient failure retries
  // rather than dropping transcript rows). Gating is implicit: buildSummaryBatch returns
  // only batch-mode sessions, so a deterministic floor yields zero calls -> no model.
  async function tickSummary() {
    if (summaryInFlight) return { tier: "summary", skipped: "in-flight" };
    summaryInFlight = true;
    try {
      // Capture the active conversations ONCE this tick — the apply-plan re-resolves
      // returned rows against THIS exact set (a call that ends mid-tick is rejected, not
      // misrouted) and the cursor is computed from the rows actually sent.
      const conversations = buildSummaryBatch ? buildSummaryBatch({ ...batchOptions }) : { conversations: [] };
      const req = buildRollingSummaryBatchRequest(conversations, {
        cursor: summaryCursor,
        cadenceMs: summaryIntervalMs,
      });
      if (!req.calls.length) {
        const out = { tier: "summary", fired: false, reason: "no-calls" }; // nothing new past the cursor
        if (onTick) onTick(out);
        return out;
      }
      if (!runSummary) {
        const out = { tier: "summary", fired: false, reason: "no-runner" };
        if (onTick) onTick(out);
        return out; // do NOT advance cursor: rows stay pending until a runner exists
      }
      const res = await runSummary(buildRollingSummaryPrompt(req));
      if (modelFailure(res)) {
        const out = { tier: "summary", fired: false, reason: "model-failed", error: modelFailureMessage(res) };
        if (onTick) onTick(out);
        return out; // cursor NOT advanced => retry next tick
      }
      const parsed = parseRollingSummaryResult(res, { batchId: req.batchId, generatedAt: req.generatedAt });
      const plan = buildRollingSummaryApplyPlan(conversations, parsed, { batchRequest: req });
      let writtenSessionIds = null; // string[] when the writeback reports what it actually wrote
      try {
        const result = applySummary(plan);
        if (Array.isArray(result)) writtenSessionIds = result;
      } catch (error) {
        log("warn", "coach_floor.summary_apply_error", { error: error.message });
        return { tier: "summary", fired: false, error: error.message }; // cursor NOT advanced => retry
      }
      // Advance only after a clean apply, and MERGE onto the prior cursor so sessions not
      // re-summarized this tick keep their place; only sessions actually written advance.
      summaryCursor = buildRollingSummaryCursorFromApplyPlan(plan, {
        previousCursor: summaryCursor,
        onlySessionIds: writtenSessionIds,
      });
      const out = {
        tier: "summary",
        fired: true,
        applyCount: plan.applyCount || 0,
        rejectedCount: plan.rejectedCount || 0,
      };
      if (onTick) onTick(out);
      return out;
    } catch (error) {
      log("warn", "coach_floor.summary_error", { error: error.message });
      return { tier: "summary", fired: false, error: error.message };
    } finally {
      summaryInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    if (runReactor && startInterval) {
      reactorHandle = startInterval(() => {
        tickReactor();
      }, reactorIntervalMs);
    }
    if (runDeep && startInterval) {
      deepHandle = startInterval(() => {
        tickDeep();
      }, deepIntervalMs);
    }
    if (runSummary && startInterval) {
      summaryHandle = startInterval(() => {
        tickSummary();
      }, summaryIntervalMs);
    }
    log("info", "coach_floor.started", {
      reactor: Boolean(runReactor),
      deep: Boolean(runDeep),
      summary: Boolean(runSummary),
      reactorIntervalMs,
      deepIntervalMs,
      summaryIntervalMs,
    });
  }

  function stop() {
    running = false;
    if (reactorHandle && stopInterval) stopInterval(reactorHandle);
    if (deepHandle && stopInterval) stopInterval(deepHandle);
    if (summaryHandle && stopInterval) stopInterval(summaryHandle);
    reactorHandle = null;
    deepHandle = null;
    summaryHandle = null;
    log("info", "coach_floor.stopped", {});
  }

  return {
    start,
    stop,
    tickReactor,
    tickDeep,
    tickSummary,
    getCursor: () => cursor,
    getSummaryCursor: () => summaryCursor,
    isRunning: () => running,
  };
}

module.exports = { createCoachFloorLoop };
