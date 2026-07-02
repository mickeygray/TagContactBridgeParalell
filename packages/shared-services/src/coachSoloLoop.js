"use strict";

/**
 * coachSoloLoop — the COLLAPSED single-model floor coach (one cadence, one model call).
 *
 * This is the single-call sibling of coachFloorLoop. The 3-lane batch loop
 * (reactor/deep/summary) is preserved UNCHANGED in coachFloorLoop.js; this file is the
 * collapse: every tick (default 10s) it makes ONE model call on the SAME "big prompt" the
 * deep pull uses (coachBatchRunner DEEP_PULL tier), then both steers the cockpit and
 * surfaces the recommended line.
 *
 * Per tick:
 *   1. GROWTH GATE  — buildChanges(cursor): no active calls => no model; nothing grew => no model.
 *   2. BIG PROMPT   — buildBatch() (FULL pass) -> buildBatchGuidanceRequest(DEEP_PULL).
 *   3. ONE CALL     — runSolo(req)  (the injected Sonnet transport).
 *   4. STEER        — reduceDeepPullSteering(parsed) -> applySteering -> session cockpit.
 *   5. LIVE SAY     — each row's rec:true say -> emitGuidance (reactor-shaped), deduped on text.
 *
 * Only the MODEL and the CADENCE differ from the deep pull; the prompt is identical, so the
 * Opus "big prompt" runs verbatim on Sonnet. Pure: every bus-coupled dependency is injected,
 * so the whole tick is testable offline with fakes. Safety mirrors coachFloorLoop: firing
 * gate, in-flight guard, a cursor that advances only after an accepted pass (a transient
 * model failure retries rather than dropping changes), and every tick wrapped so it can never
 * throw out of a timer.
 */

const {
  DEEP_PULL,
  buildBatchGuidanceRequest,
  parseBatchGuidance,
  shouldFireCoach,
  reduceDeepPullSteering,
} = require("./coachBatchRunner");

function cleanLine(value, max = 500) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Pure: turn parsed DEEP rows into reactor-shaped live dispatches from each row's rec say.
 * Only rows with a recommended say produce a dispatch. `lastSayBySession` dedups so the same
 * line never re-bubbles tick after tick (the cockpit already holds the full says list).
 */
function buildLiveDispatches(parsed, lastSayBySession) {
  const rows = Array.isArray(parsed && parsed.guidance) ? parsed.guidance : [];
  const dispatches = [];
  for (const row of rows) {
    if (!row || !row.sessionId) continue;
    const says = Array.isArray(row.says) ? row.says : [];
    const rec = says.find((s) => s && s.rec) || says[0] || null;
    const text = rec ? cleanLine(rec.text, 700) : "";
    if (!text) continue;
    if (lastSayBySession && lastSayBySession.get(row.sessionId) === text) continue; // unchanged -> don't repeat
    dispatches.push({
      sessionId: row.sessionId,
      text,
      dispatch: {
        target: { sessionId: row.sessionId, uii: row.uii || null },
        payload: {
          mode: "guidance",
          read: cleanLine(row.summary, 300) || null,
          steer: row.currentSection
            ? `section ${row.currentSection}`
            : rec && rec.tag
              ? cleanLine(rec.tag, 60)
              : null,
          try: text,
          id: `solo-${row.sessionId}`,
        },
      },
    });
  }
  return dispatches;
}

function createCoachSoloLoop(deps = {}) {
  const {
    // bus-coupled inputs (injected)
    buildChanges = null, // (input:{...batchOptions, cursor}) => changeSet   (growth gate; null => fire on every live tick)
    buildBatch, // (input:{...batchOptions}) => batch        (FULL pass fed to the big prompt)
    runSolo = null, // async (req) => res | null              (the ONE Sonnet transport; null => loop idles)
    applySteering = () => {}, // (updates[]) => void          (deep -> session cockpit writeback)
    emitGuidance = null, // (dispatch) => void                (live say; null => cockpit-only)
    // config
    reference = "",
    batchOptions = {},
    soloIntervalMs = 10000,
    growthGated = true, // skip the model when no transcript grew since the last tick
    // injected scheduler (bus passes setInterval+unref; tests drive ticks by hand)
    startInterval = null,
    stopInterval = null,
    logger = null,
    onTick = null, // test/observability hook
  } = deps;

  let cursor = null;
  let inFlight = false;
  let handle = null;
  let running = false;
  const lastSayBySession = new Map();

  function log(level, msg, data) {
    if (logger && typeof logger[level] === "function") logger[level](msg, data);
  }
  function modelFailure(res) {
    return !res || (typeof res === "object" && res.ok === false);
  }
  function modelFailureMessage(res) {
    return res && typeof res === "object" && res.error ? String(res.error) : "model-returned-empty";
  }
  // Evict dedup memory for sessions no longer in the active batch (ended calls) so the
  // map can't grow unbounded over a long-running floor process.
  function pruneDedup(batch) {
    const conversations = batch && Array.isArray(batch.conversations) ? batch.conversations : [];
    const activeIds = new Set(conversations.map((c) => c && c.sessionId).filter(Boolean));
    for (const id of lastSayBySession.keys()) {
      if (!activeIds.has(id)) lastSayBySession.delete(id);
    }
  }

  async function tick() {
    if (inFlight) return { skipped: "in-flight" };
    inFlight = true;
    try {
      // GROWTH GATE: the change-set decides WHETHER to fire; the prompt still gets the FULL
      // batch. No active calls -> no model. Nothing grew since last tick -> no model.
      const changes = buildChanges ? buildChanges({ ...batchOptions, cursor }) : null;
      if (changes) {
        const active = Number(changes.activeConversationCount || 0);
        if (!(active > 0)) {
          cursor = changes.cursor ?? cursor;
          const out = { fired: false, reason: "no-active-conversations" };
          if (onTick) onTick(out);
          return out;
        }
        if (growthGated && !changes.hasChanges) {
          cursor = changes.cursor ?? cursor; // nothing grew -> advance and wait
          const out = { fired: false, reason: "no-changes" };
          if (onTick) onTick(out);
          return out;
        }
      }
      if (!runSolo) {
        const out = { fired: false, reason: "no-runner" };
        if (onTick) onTick(out);
        return out; // do NOT advance cursor: stays pending until a runner exists
      }
      const batch = buildBatch({ ...batchOptions });
      const gate = shouldFireCoach(batch, { tier: DEEP_PULL });
      if (!gate.fire) {
        cursor = changes?.cursor ?? cursor;
        const out = { fired: false, reason: gate.reason };
        if (onTick) onTick(out);
        return out;
      }
      const req = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference });
      const res = await runSolo(req);
      if (modelFailure(res)) {
        const out = { fired: false, reason: "model-failed", error: modelFailureMessage(res) };
        if (onTick) onTick(out);
        return out; // cursor NOT advanced => retry next tick
      }
      const parsed = parseBatchGuidance(res, { tier: DEEP_PULL, generatedAt: batch.generatedAt });
      const updates = reduceDeepPullSteering(parsed);
      if (!updates.length) {
        // ok:true but no USABLE guidance (refusal / tool-only / max_tokens-truncated invalid
        // JSON all parse to guidance:[]). Do NOT advance the cursor — the growth that opened
        // this tick must retry next tick, not be silently dropped.
        const out = { fired: false, reason: "empty-guidance" };
        if (onTick) onTick(out);
        return out;
      }
      // 1) strategic state -> cockpit
      try {
        applySteering(updates);
      } catch (error) {
        log("warn", "coach_solo.steering_error", { error: error.message });
      }
      // 2) recommended line -> live say. Deduped on text so an unchanged rec never re-bubbles,
      //    but the dedup key is recorded ONLY when the bus confirms delivery (emitGuidance
      //    returns !== false) — a silent no-op (session went terminal / flipped out of batch
      //    mode mid-call) must not suppress that line on the next tick.
      let emitted = 0;
      if (emitGuidance) {
        const dispatches = buildLiveDispatches(parsed, lastSayBySession);
        for (const item of dispatches) {
          let delivered = true;
          try {
            delivered = emitGuidance(item.dispatch) !== false;
          } catch (error) {
            delivered = false;
            log("warn", "coach_solo.emit_error", { error: error.message });
          }
          if (delivered) {
            lastSayBySession.set(item.sessionId, item.text);
            emitted += 1;
          }
        }
      }
      pruneDedup(batch);
      cursor = changes?.cursor ?? cursor; // advance only after an accepted pass
      const out = { fired: true, stateUpdates: updates.length, emitted };
      if (onTick) onTick(out);
      return out;
    } catch (error) {
      log("warn", "coach_solo.tick_error", { error: error.message });
      return { fired: false, error: error.message }; // cursor NOT advanced => retry next tick
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    if (runSolo && startInterval) {
      handle = startInterval(() => {
        tick();
      }, soloIntervalMs);
    }
    log("info", "coach_solo.started", {
      soloIntervalMs,
      growthGated,
      hasRunner: Boolean(runSolo),
      liveSay: Boolean(emitGuidance),
    });
  }

  function stop() {
    running = false;
    if (handle && stopInterval) stopInterval(handle);
    handle = null;
    lastSayBySession.clear();
    log("info", "coach_solo.stopped", {});
  }

  return {
    start,
    stop,
    tick,
    getCursor: () => cursor,
    isRunning: () => running,
  };
}

module.exports = { createCoachSoloLoop, buildLiveDispatches };
