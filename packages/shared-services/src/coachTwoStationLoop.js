"use strict";

// THE TWO-STATION COACH RUNTIME (2026-07-08). The loop the state-of-play doc calls
// "what has NOT been coded, item 1" — B/STRATEGIST + A/COACH in their real cadence:
//
//   B (Sonnet, the big prompt + reference) regrounds a session's cockpit on a SLOW
//     clock (~5 min) — and IMMEDIATELY the first time a session shows a substantive
//     turn (that is the 3-minute warm-up fix: no session waits for a timer).
//   A (Haiku, small prompt, NO reference) fires every ~3 SUBSTANCE-FLOORED turns
//     (coachTurnAccumulator — committed finals only, the A3 audit fix), reads B's
//     play menu from the loop's OWN per-session state (never through the write-only
//     session.callStrategy hole — audit A5), adapts the words, speaks or HOLDs.
//
// Emission reuses the shipped channels byte-for-byte, so the existing cockpit UI
// renders this loop with zero client changes:
//   applySteering(updates[])  -> session.latest.cockpit + SSE "coach.cockpit"
//   emitGuidance(dispatch)    -> session.latest.dialog  + SSE "dialog"
//     (returns false on silent no-op and NEVER true — audit A10 — so delivery is
//     recorded on `!== false`, same as the solo loop.)
//
// Doctrine carried from the evals (do not weaken):
//   * HOLD is first-class: B says:[] / A say:"" = deliberate silence, counted, logged.
//   * When a transport fails, the coach goes QUIET (cooldown), never hot-retries —
//     the A2 infinite-paid-retry lesson. Truncation IS failure (stop_reason checked
//     in the transport).
//   * The tick never throws; a coach bug must never touch the call.
//
// Fires-vs-ticks accounting is built in (state-of-play pending item 7): every commit,
// fire, hold, dedupe, reground, failure, and token is counted per loop and readable
// via getCounters() — the pilot's real-fire-rate numbers come from here.

const { createCoachTurnAccumulator } = require("./coachTurnAccumulator");
const { buildStrategistRequest, buildCoachRequest } = require("./coachTwoStationPrompts");
const { repairModelJson } = require("./coachBatchRunner");

const DEFAULT_TICK_MS = 2000;
const DEFAULT_B_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_B_MIN_REGAP_MS = 60 * 1000;
const DEFAULT_A_TURNS = 3;
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_MAX_SESSIONS = 12;
const A_WINDOW_TURNS = 3;

function str(value, max = 4000) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

function renderTurns(rows) {
  return rows
    .map((row) => `${row.role === "agent" ? "agent" : row.role === "prospect" ? "prospect" : row.role || "unknown"}: ${String(row.text || "").trim()}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
}

// keep exactly one rec:true on a non-empty menu (parse-layer ensureOneRec equivalent);
// rec is coerced to a strict boolean first (models emit rec:"true" strings)
function ensureOneRec(says) {
  const list = Array.isArray(says) ? says.filter((s) => s && typeof s === "object") : [];
  if (!list.length) return [];
  let seen = false;
  for (const s of list) {
    s.rec = s.rec === true || s.rec === "true";
    if (s.rec) {
      if (seen) s.rec = false;
      seen = true;
    }
  }
  if (!seen) list[0].rec = true;
  return list;
}

function addUsage(bucket, usage) {
  if (!usage || typeof usage !== "object") return;
  bucket.inputTokens += Number(usage.input_tokens) || 0;
  bucket.outputTokens += Number(usage.output_tokens) || 0;
  bucket.cacheReadTokens += Number(usage.cache_read_input_tokens) || 0;
  bucket.cacheWriteTokens += Number(usage.cache_creation_input_tokens) || 0;
}

function createCoachTwoStationLoop(deps = {}) {
  const {
    buildBatch,
    applySteering,
    emitGuidance,
    runStrategist,
    runCoach,
    reference = "",
    feeAmount = "$3,500",
    logger = console,
    startInterval = (fn, ms) => {
      const h = setInterval(fn, ms);
      if (typeof h.unref === "function") h.unref();
      return h;
    },
    stopInterval = clearInterval,
    now = () => Date.now(),
  } = deps;

  const tickMs = Math.max(Number(deps.tickMs) || DEFAULT_TICK_MS, 500);
  const bIntervalMs = Math.max(Number(deps.bIntervalMs) || DEFAULT_B_INTERVAL_MS, 30_000);
  const bMinRegapMs = Math.max(Number(deps.bMinRegapMs) || DEFAULT_B_MIN_REGAP_MS, 5_000);
  const aTurnThreshold = Math.max(Number(deps.aTurnThreshold) || DEFAULT_A_TURNS, 1);
  const failureCooldownMs = Math.max(Number(deps.failureCooldownMs) || DEFAULT_FAILURE_COOLDOWN_MS, 5_000);
  const maxSessions = Math.max(Number(deps.maxSessions) || DEFAULT_MAX_SESSIONS, 1);

  // per-session runtime state — THE B->A handoff lives here, in-process
  const sessions = new Map();
  const counters = {
    ticks: 0,
    turnsCommitted: 0,
    turnsDropped: 0,
    bRegrounds: 0,
    bFailures: 0,
    bHolds: 0, // B returned an empty menu (says: []) — a strategist HOLD
    aFires: 0,
    aHolds: 0,
    aDupes: 0,
    aFailures: 0,
    aSkipsNoCockpit: 0,
    usage: {
      strategist: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      coach: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
  let timer = null;
  let tickInFlight = false;
  let stopRequested = false;

  function sessionState(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        accumulator: createCoachTurnAccumulator({ threshold: aTurnThreshold }),
        seenRowIds: new Set(),
        committedRows: [], // substantive + backchannel finals, for windows/transcript
        cockpit: null, // B's latest: { currentSection, says, beats, remember, priorFlags }
        bSummary: "",
        lastBAt: 0,
        newSinceB: false,
        bCooldownUntil: 0,
        aGuidance: "",
        aSummary: "",
        aCooldownUntil: 0,
        lastSay: null,
        pendingFire: false,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  // feed NEW committed transcript rows into the accumulator; provisionals never count
  function ingestRows(state, conversation) {
    const rows = conversation?.arrays?.transcript;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const id = row && row.id ? String(row.id) : null;
      if (!id || state.seenRowIds.has(id)) continue;
      state.seenRowIds.add(id);
      if (row.provisional) continue;
      state.committedRows.push({ role: row.role, text: row.text });
      if (state.committedRows.length > 240) state.committedRows.shift();
      const verdict = state.accumulator.commit({ speaker: row.role, text: row.text, final: true });
      if (verdict.counted) {
        counters.turnsCommitted += 1;
        state.newSinceB = true;
      } else {
        counters.turnsDropped += 1;
      }
      if (verdict.fire) state.pendingFire = true;
    }
  }

  async function regroundStrategist(sessionId, state, conversation) {
    const t = now();
    if (t < state.bCooldownUntil) return;
    if (!state.committedRows.length) return;
    // Stamp BEFORE the call so a slow call can't double-fire — but keep the prior
    // values so a FAILURE restores them (review: without the restore, a failed
    // reground consumed its own trigger — the 60s cooldown became a 5-minute-plus
    // wait for a NEW turn, and a quiet-tail call never regrounded again).
    const prevLastBAt = state.lastBAt;
    const prevNewSinceB = state.newSinceB;
    state.lastBAt = t;
    state.newSinceB = false;

    const req = buildStrategistRequest({
      reference,
      transcript: renderTurns(state.committedRows),
      priorSummaryText: state.bSummary,
    });
    let res = null;
    try {
      res = await runStrategist({ system: req.system, prompt: req.prompt });
    } catch (error) {
      res = { ok: false, error: error?.message };
    }
    // billed usage is metered even on failure (a truncated call bills full tokens)
    if (res?.usage) {
      counters.usage.strategist.calls += 1;
      addUsage(counters.usage.strategist, res.usage);
    }
    if (!res || res.ok === false) {
      counters.bFailures += 1;
      state.bCooldownUntil = now() + Math.max(Number(res?.retryAfterMs) || 0, failureCooldownMs);
      state.lastBAt = prevLastBAt;
      state.newSinceB = prevNewSinceB || state.newSinceB; // keep any turn that landed mid-flight
      logger.warn?.("coach_two_station.b.failed", { sessionId, error: res?.error || "no-result" });
      return;
    }

    const json = repairModelJson(res.text);
    const row = json && Array.isArray(json.guidance) ? json.guidance[0] : null;
    if (!row || typeof row !== "object") {
      counters.bFailures += 1;
      state.bCooldownUntil = now() + failureCooldownMs;
      state.lastBAt = prevLastBAt;
      state.newSinceB = prevNewSinceB || state.newSinceB;
      logger.warn?.("coach_two_station.b.unparseable", { sessionId, sample: str(res.text, 160) });
      return;
    }
    let says = ensureOneRec(row.says);
    const section = str(row.currentSection, 12);
    if (!says.length) {
      counters.bHolds += 1;
      // mirror the UI channel's coalesce: a same-section HOLD keeps the prior menu on
      // the agent's screen (applyDeepSteering), so A's menu must keep it too or the
      // two diverge — the agent reads plays A no longer knows about
      const sameSection = state.cockpit && state.cockpit.currentSection === section;
      if (sameSection && Array.isArray(state.cockpit.says)) says = state.cockpit.says;
    }
    const freshSummary = typeof json.summary === "string" && json.summary.trim()
      ? json.summary.trim()
      : str(json.summary?.summaryText || "");
    const summary = freshSummary || state.bSummary;

    state.cockpit = {
      currentSection: section,
      says,
      beats: Array.isArray(row.beats) ? row.beats : [],
      remember: Array.isArray(row.remember) ? row.remember : [],
      priorFlags: Array.isArray(row.priorFlags) ? row.priorFlags : [],
    };
    state.bSummary = summary;
    // B just re-read the WHOLE transcript — its fresh summary displaces A's rolling
    // one (which otherwise could never be refreshed: aSummary || bSummary). Only when
    // GENUINELY fresh: if B omitted its summary, A's rolling one stays (review fix —
    // resetting onto the stale fallback destroyed the freshest state for nothing).
    if (freshSummary) state.aSummary = "";
    counters.bRegrounds += 1;

    const rec = says.find((s) => s.rec) || says[0] || null;
    try {
      applySteering([{
        sessionId,
        uii: conversation?.call?.uii || null,
        currentSection: state.cockpit.currentSection,
        summary,
        beats: state.cockpit.beats,
        remember: state.cockpit.remember,
        says,
        priorFlags: state.cockpit.priorFlags,
        generatedAt: new Date(now()).toISOString(),
        callStrategy: rec ? `section ${state.cockpit.currentSection || "?"} — ${str(rec.text, 200)}` : null,
      }]);
    } catch (error) {
      logger.warn?.("coach_two_station.b.steer_failed", { sessionId, error: error?.message });
    }
    logger.info?.("coach_two_station.b.reground", {
      sessionId,
      section: state.cockpit.currentSection,
      plays: says.length,
      hold: says.length === 0,
    });
  }

  async function fireCoach(sessionId, state, conversation) {
    const t = now();
    // The trigger is consumed only when A actually runs (review: consuming it before
    // the guards destroyed every fire that landed during a cooldown — post-failure
    // silence stretched to cooldown + a whole fresh threshold). A deferred fire
    // simply retries next tick; it is NOT a hot model call.
    if (t < state.aCooldownUntil) return;
    if (!state.cockpit) {
      // count deferral EPISODES, not 2s ticks — one cooling first-ground must not
      // read as 30 skips in the pilot's meter
      if (!state.noCockpitSkipCounted) {
        counters.aSkipsNoCockpit += 1;
        state.noCockpitSkipCounted = true;
      }
      return; // B grounds first; the fire stays pending
    }
    state.noCockpitSkipCounted = false;
    state.pendingFire = false;
    const req = buildCoachRequest({
      currentSection: state.cockpit.currentSection,
      says: state.cockpit.says,
      priorGuidance: state.aGuidance,
      summaryText: state.aSummary || state.bSummary,
      lastTurns: renderTurns(state.committedRows.slice(-A_WINDOW_TURNS)),
      fee: feeAmount,
    });
    let res = null;
    try {
      res = await runCoach({ system: req.system, prompt: req.prompt });
    } catch (error) {
      res = { ok: false, error: error?.message };
    }
    if (res?.usage) {
      counters.usage.coach.calls += 1;
      addUsage(counters.usage.coach, res.usage);
    }
    if (!res || res.ok === false) {
      counters.aFailures += 1;
      state.aCooldownUntil = now() + Math.max(Number(res?.retryAfterMs) || 0, failureCooldownMs);
      logger.warn?.("coach_two_station.a.failed", { sessionId, error: res?.error || "no-result" });
      return;
    }

    // unparseable A output is a FAILURE with cooldown, never a HOLD — a prose-mode
    // Haiku must not be re-billed every threshold while the meter reads "holding"
    const json = repairModelJson(res.text);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      counters.aFailures += 1;
      state.aCooldownUntil = now() + failureCooldownMs;
      logger.warn?.("coach_two_station.a.unparseable", { sessionId, sample: str(res.text, 160) });
      return;
    }
    const say = str(json.say, 700);
    if (str(json.guidance, 700)) state.aGuidance = str(json.guidance, 700);
    // rolling summary keeps the TAIL (it appends at the tail — a head clamp froze it
    // on the call's first minutes forever)
    const newSummary = typeof json.summary === "string" ? json.summary.trim() : "";
    if (newSummary) state.aSummary = newSummary.length > 2000 ? newSummary.slice(-2000) : newSummary;

    if (!say) {
      counters.aHolds += 1; // deliberate silence — the whole point of the gate
      logger.info?.("coach_two_station.a.hold", { sessionId });
      return;
    }
    if (state.lastSay && say === state.lastSay) {
      counters.aDupes += 1;
      return;
    }
    const summarySource = state.aSummary || state.bSummary || "";
    const dispatch = {
      target: { sessionId, uii: conversation?.call?.uii || null },
      payload: {
        mode: "guidance",
        // the TAIL of the rolling summary — head-300 goes stale after the first fires
        read: summarySource.length > 300 ? summarySource.slice(-300) : summarySource,
        steer: state.cockpit.currentSection ? `section ${state.cockpit.currentSection}` : "",
        try: say,
        id: `two-station-${sessionId}-${counters.aFires + 1}`,
      },
    };
    let delivered = false;
    try {
      delivered = emitGuidance(dispatch) !== false; // A10: emit never returns true
    } catch (error) {
      logger.warn?.("coach_two_station.a.emit_failed", { sessionId, error: error?.message });
    }
    if (delivered) {
      state.lastSay = say;
      counters.aFires += 1;
      logger.info?.("coach_two_station.a.fired", { sessionId, chars: say.length });
    }
  }

  async function tick() {
    if (tickInFlight) return { skipped: "in-flight" };
    tickInFlight = true;
    counters.ticks += 1;
    try {
      const batch = typeof buildBatch === "function" ? buildBatch({ maxSessions }) : null;
      const conversations = Array.isArray(batch?.conversations) ? batch.conversations : [];
      const liveIds = new Set();

      for (const conversation of conversations) {
        if (stopRequested) break; // a kill mid-episode silences the CURRENT round too
        const sessionId = conversation?.sessionId;
        if (!sessionId) continue;
        liveIds.add(sessionId);
        const state = sessionState(sessionId);
        ingestRows(state, conversation);

        const t = now();
        const needsFirstGround = !state.cockpit && state.committedRows.length > 0 && state.accumulator.peek().totalCounted > 0;
        const needsReground = state.cockpit && state.newSinceB
          && t - state.lastBAt >= bIntervalMs;
        const regapOk = t - state.lastBAt >= bMinRegapMs || state.lastBAt === 0;
        if ((needsFirstGround || needsReground) && regapOk && runStrategist) {
          await regroundStrategist(sessionId, state, conversation);
        }
        if (state.pendingFire && runCoach) {
          await fireCoach(sessionId, state, conversation);
        }
      }

      // sessions gone from the batch are over — drop their state
      for (const sessionId of sessions.keys()) {
        if (!liveIds.has(sessionId)) sessions.delete(sessionId);
      }
      return { sessions: conversations.length };
    } catch (error) {
      logger.warn?.("coach_two_station.tick_failed", { error: error?.message });
      return { failed: true };
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (timer) return false;
      stopRequested = false;
      timer = startInterval(() => { tick(); }, tickMs);
      logger.info?.("coach_two_station.started", {
        tickMs, bIntervalMs, aTurnThreshold, maxSessions,
      });
      return true;
    },
    stop() {
      stopRequested = true; // also quiesces an in-flight tick between sessions
      if (!timer) return;
      stopInterval(timer);
      timer = null;
    },
    tick, // tests drive this directly
    isRunning: () => Boolean(timer),
    getCounters: () => JSON.parse(JSON.stringify(counters)),
    getSessionCount: () => sessions.size,
  };
}

module.exports = { createCoachTwoStationLoop };
