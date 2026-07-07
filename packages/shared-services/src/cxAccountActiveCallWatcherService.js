"use strict";

const bulkWatcher = require("./cxBulkLoadActiveCallWatcher");
const { logCxAlpha } = require("./cxAlphaTraceService");
const { reduceCxBulkLoadState } = require("./cxBulkLoadStateMachine");
const { describeBulkLoadMutationEligibility, buildVersionGuardOptions } = require("./cxBulkLoadMutationEligibility");

function str(value) {
  return String(value == null ? "" : value).trim();
}

function traceWatcher(event, payload = {}) {
  logCxAlpha(event, { rail: "bulk_load", ...payload });
}

function isRealRingcxUii(value) {
  const text = str(value);
  return Boolean(text) && !text.toLowerCase().startsWith("cx-synth:");
}

function normalizeAccountId(value) {
  return str(value) || null;
}

function normalizePhoneDigits(value) {
  const digits = str(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function nowDate(input) {
  return input instanceof Date ? input : new Date(input || Date.now());
}

function queueItemKey(value = null) {
  return str(value?.queueItemId || value?.id || value?._id);
}

function hasTerminalWriteProof(candidate = null) {
  return Boolean(queueItemKey(candidate) && isRealRingcxUii(candidate?.uii));
}

function summarizeProjection(projection = {}) {
  return {
    sessionId: projection.sessionId || null,
    agentEmail: projection.agentEmail || null,
    agentExtensionId: projection.agentExtensionId || null,
    accountId: projection.accountId || null,
    changed: Boolean(projection.changed),
    error: projection.error || null,
    activeCallCount: Number(projection.activeCallCount || 0),
    relevantActiveCallCount: Number(projection.relevantActiveCallCount || 0),
    releasedCount: Number(projection.releasedCount || 0),
    terminalObservationCount: Array.isArray(projection.terminalObservations)
      ? projection.terminalObservations.length
      : 0,
    matchStatus: projection.matchStatus || null,
    transitionKind: projection.transitionKind || null,
    currentQueueItemId: projection.currentQueueItemId || null,
    currentUii: projection.currentUii || null,
    currentPromotionRequired: Boolean(projection.currentPromotion?.required),
    currentPromotionKind: projection.currentPromotion?.kind || null,
  };
}

function reviewHoldUntilMs(state = {}) {
  const value = state?.reviewHoldUntil;
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function isReviewHoldActive(state = {}, at = new Date()) {
  const untilMs = reviewHoldUntilMs(state);
  if (!untilMs) return false;
  const nowMs = at instanceof Date ? at.getTime() : Date.parse(String(at || ""));
  return Number.isFinite(nowMs) && untilMs > nowMs;
}

function readReviewHoldMs(options = {}) {
  if (options.reviewHoldMs !== undefined) {
    const explicit = Number(options.reviewHoldMs);
    return Number.isFinite(explicit) && explicit >= 0 ? explicit : 0;
  }
  const envValue = Number(process.env.CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return 3000;
}

function buildReviewHoldUntil(options = {}, at = new Date()) {
  const holdMs = readReviewHoldMs(options);
  if (holdMs <= 0) return null;
  const base = at instanceof Date ? at : new Date(at || Date.now());
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + holdMs).toISOString();
}

function compactActiveCall(call = {}) {
  return {
    externId: str(call.externId || call.externalId || call.outboundExternid) || null,
    uii: str(call.uii) || null,
    callState: call.callState || call.state || null,
    ani: str(call.ani || call.aniE164) || null,
    dnis: str(call.dnis || call.dnisE164) || null,
    agentId: str(call.agentId || call.username) || null,
  };
}

function compactActiveCalls(calls = []) {
  return (Array.isArray(calls) ? calls : [])
    .map(compactActiveCall)
    .filter((call) => call.externId || call.uii);
}

function candidatePool(state = {}) {
  const pool = [];
  if (Array.isArray(state.acceptedBuffer)) pool.push(...state.acceptedBuffer);
  if (state.current) pool.push(state.current);
  return pool;
}

function candidateExternId(candidate = {}) {
  return str(candidate.externId || candidate.ringcx?.externId);
}

function compactCandidate(candidate = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  return {
    queueItemId: queueItemKey(candidate) || null,
    externId: candidateExternId(candidate) || null,
    caseId: candidate.caseId || null,
    name: str(candidate.name) || null,
    status: candidate.status || candidate.phase || null,
    uii: str(candidate.uii) || null,
    queueFamily: candidate.queueFamily || null,
  };
}


function groupBulkSessionsByAccount(sessions = []) {
  const byAccount = new Map();
  const skipped = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const accountId = normalizeAccountId(session?.ringcx?.accountId || session?.accountId);
    if (!accountId) {
      skipped.push({ sessionId: session?.sessionId || null, reason: "missing-account-id" });
      continue;
    }
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(session);
  }
  return { byAccount, skipped };
}

// REAL-PICKUP GUARD (Mickey, 2026-07-02): "answered" must mean a human picked up.
// A Google-screener / carrier-VM kick SIP-answers for a few seconds; a conversation
// lasts. If the machine-defaulted outcome is "answered" but the connection lasted
// less than answeredMinConnectedMs, downgrade to did_not_connect. Explicit option
// wins; env CX_BULK_ANSWERED_MIN_CONNECTED_MS next; default 10000ms; 0 disables.
function applyAnsweredGuard(outcome, current = null, at = new Date(), options = {}) {
  if (outcome !== "answered") return outcome;
  const fromEnv = Number(process.env.CX_BULK_ANSWERED_MIN_CONNECTED_MS);
  const minMs = options.answeredMinConnectedMs != null
    ? Number(options.answeredMinConnectedMs)
    : (Number.isFinite(fromEnv) ? fromEnv : 10000);
  if (!Number.isFinite(minMs) || minMs <= 0) return outcome;
  const connectedMs = current?.connectedAt ? at.getTime() - new Date(current.connectedAt).getTime() : 0;
  return connectedMs >= minMs ? outcome : "did_not_connect";
}

function withWatcherTrace(state = {}, patch = {}, at = new Date()) {
  const checkedAt = nowDate(at).toISOString();
  return {
    ...state,
    trace: {
      ...(state.trace || {}),
      accountActiveCallWatcher: {
        checkedAt,
        source: "account-active-call-snapshot",
        ...(patch || {}),
      },
    },
  };
}

function projectBulkSessionFromAccountSnapshot(session = {}, activeCalls = [], options = {}) {
  const watcher = options.watcher || bulkWatcher;
  const reduce = options.reduce || reduceCxBulkLoadState;
  const at = nowDate(options.now);
  const accountId = normalizeAccountId(session?.ringcx?.accountId || session?.accountId);
  const normalizedCalls = Array.isArray(activeCalls)
    ? activeCalls.map((call) => watcher.normalizeActiveCall ? watcher.normalizeActiveCall(call) : compactActiveCall(call))
    : [];
  const compactCalls = compactActiveCalls(normalizedCalls);
  const pool = candidatePool(session);
  const candidateExternIds = new Set(pool.map(candidateExternId).filter(Boolean));
  let relevantCalls = compactCalls.filter((call) => call.externId && candidateExternIds.has(call.externId));
  const currentBefore = queueItemKey(session.current);
  const currentUiiBefore = str(session.current?.uii);

  const releaseDiff = watcher.deriveReleasedCandidates({
    prevActiveExternIds: session.prevActiveExternIds || [],
    prevActiveCalls: session.trace?.prevActiveCalls || [],
    activeCalls: relevantCalls,
    pool: session.acceptedBuffer || [],
  });

  const terminalObservations = [];
  let next = session;
  for (const released of releaseDiff.released) {
    if (hasTerminalWriteProof(released)) {
      terminalObservations.push({
        source: "active-call-release",
        outcome: "did_not_connect",
        candidate: released,
      });
    }
    next = reduce(next, { type: "buffer.released", candidate: released, outcome: "did_not_connect" }, at);
  }
  // CONNECTED LATCH (congestion fix, 2026-07-02): a UII is assigned at DIAL time —
  // OUTDIAL attempts (incl. carrier-congested calls that flash into the list and
  // vanish) carry one too, so UII presence must never mean "a human answered".
  // The honest signal is the state transition: stamp connectedAt ONCE when the
  // current's uii is observed in a connected-family state. Field evidence: all
  // promotion-time stamps read OUTDIAL; congestion = uii + OUTDIAL-only + vanish.
  if (next.current && str(next.current.uii) && !next.current.connectedAt) {
    const liveRow = relevantCalls.find(
      (call) => str(call.uii) === str(next.current.uii) && CONNECTED_STATES.has(str(call.callState).toUpperCase()),
    );
    if (liveRow) {
      next = { ...next, current: { ...next.current, connectedAt: at.toISOString() } };
    }
  }

  const currentReleased = watcher.deriveCurrentRelease
    ? watcher.deriveCurrentRelease({
        current: next.current,
        prevActiveCalls: session.trace?.prevActiveCalls || [],
        activeCalls: relevantCalls,
      })
    : null;
  if (currentReleased) {
    // TRUNK RULING (2026-07-02): call end ≠ outcome for a CONNECTED call. A current
    // that reached a connected state was a human's call — hold it in WRAP (same
    // current, buttons stay live, the agent's disposition IS the record) instead of
    // auto-writing did_not_connect out from under them. RingCX sits in
    // dispositioning-hold waiting for that disposition, so the hold costs no
    // advancement. Never-connected releases (ring-outs, carrier congestion) keep the
    // old immediate terminal path — the machine's own outcome, and the loop moves on.
    // The wrap timeout is test/ops opt-in only: a default timeout is unsafe because
    // RingCX can drop the active-call row while the human call is still alive.
    // A genuine next-call arrival still supersedes via the current.matched switch
    // path below (completePrevious), which the correction lane can amend later.
    const wasConnected = Boolean(next.current?.connectedAt);
    const wrapTimeoutMs = resolveWrapTimeoutMs(options);
    const wrappedAtMs = next.current?.wrap?.at ? new Date(next.current.wrap.at).getTime() : null;
    const wrapExpired = wrapTimeoutMs > 0 && wrappedAtMs != null && at.getTime() - wrappedAtMs >= wrapTimeoutMs;
    if (wrappedAtMs != null && !wrapExpired) {
      // already wrapped, inside the entry window — hold, no writes (an existing wrap
      // is honored regardless of how connectivity was judged when it was set)
    } else if (wasConnected && wrappedAtMs == null) {
      next = {
        ...next,
        current: {
          ...next.current,
          wrap: { at: at.toISOString(), reason: "ringcx-current-released" },
        },
      };
    } else {
      // ANSWERED DEFAULT (Mickey, 2026-07-02): an auto-close of a call that reached
      // a connected state records "answered" (the machine knows); only a
      // never-connected release records did_not_connect. The real-pickup guard
      // downgrades short screener/VM-kick connects.
      const releaseOutcome = applyAnsweredGuard(
        next.current?.connectedAt ? "answered" : "did_not_connect",
        next.current,
        at,
        options,
      );
      if (hasTerminalWriteProof(currentReleased)) {
        terminalObservations.push({
          source: wrapExpired ? "wrap-timeout" : "active-call-release",
          outcome: releaseOutcome,
          candidate: currentReleased,
        });
      }
      next = reduce(next, {
        type: "current.released",
        outcome: releaseOutcome,
        reason: wrapExpired ? "wrap-timeout" : "ringcx-current-released",
        reviewHoldUntil: buildReviewHoldUntil(options, at),
        reviewHoldReason: "ringcx-current-released",
      }, at);
    }
  } else if (next.current?.wrap) {
    // The call reappeared in the active list — resume; clear the wrap flag.
    const currentExt = candidateExternId(next.current);
    if (currentExt && relevantCalls.some((call) => call.externId === currentExt)) {
      next = { ...next, current: { ...next.current, wrap: null } };
    }
  }

  next = {
    ...next,
    prevActiveExternIds: releaseDiff.nextActiveExternIds,
    trace: {
      ...(next.trace || {}),
      prevActiveCalls: compactActiveCalls(releaseDiff.nextActiveCalls || compactCalls),
    },
  };

  const releaseChanged = releaseDiff.released.length > 0 ||
    (session.prevActiveExternIds || []).join("|") !== releaseDiff.nextActiveExternIds.join("|");
  const holdActive = isReviewHoldActive(next, at);
  if (holdActive) {
    const currentAfterHold = queueItemKey(next.current);
    const currentChangedHold = currentBefore !== currentAfterHold || currentUiiBefore !== str(next.current?.uii);
    const changed = releaseChanged || currentChangedHold;
    next = withWatcherTrace(next, {
      accountId,
      activeCallCount: compactCalls.length,
      relevantActiveCallCount: relevantCalls.length,
      releasedCount: releaseDiff.released.length,
      currentReleased: Boolean(currentReleased),
      matchStatus: "held-review",
      transitionKind: "held-review",
      currentQueueItemId: next.current?.queueItemId || null,
      currentUii: next.current?.uii || null,
      reviewHoldUntil: next.reviewHoldUntil || null,
      terminalObservations,
      currentPromotion: null,
    }, at);
    traceWatcher("cx.alpha.watch.match_diagnostic", {
      sessionId: session.sessionId || null,
      agentEmail: session.agentEmail || null,
      agentExtensionId: session.agentExtensionId || null,
      accountId,
      activeCalls: compactCalls,
      relevantActiveCalls: relevantCalls,
      candidatePool: pool.map(compactCandidate).filter(Boolean),
      current: compactCandidate(next.current),
      matchStatus: "held-review",
      transitionKind: "held-review",
      reviewHoldUntil: next.reviewHoldUntil || null,
      currentReleased: Boolean(currentReleased),
    });

    return {
      rail: "bulk_load",
      sessionId: session.sessionId || null,
      agentEmail: session.agentEmail || null,
      agentExtensionId: session.agentExtensionId || null,
      accountId,
      changed,
      before: session,
      after: next,
      activeCallCount: compactCalls.length,
      relevantActiveCallCount: relevantCalls.length,
      releasedCount: releaseDiff.released.length,
      matchStatus: "held-review",
      transitionKind: "held-review",
      currentQueueItemId: next.current?.queueItemId || null,
      currentUii: next.current?.uii || null,
      terminalObservations,
      currentPromotion: null,
    };
  }

  const match = watcher.matchActiveCallToCandidates(relevantCalls, candidatePool(next));
  const transition = watcher.deriveCurrentTransition(next.current, match);
  let currentPromotion = null;

  if (transition.kind === "switch" || transition.kind === "same") {
    const sameCurrent =
      transition.kind === "same" &&
      str(next.current?.uii) === str(transition.uii) &&
      queueItemKey(next.current) === queueItemKey(transition.candidate);
    // ANSWERED DEFAULT (Mickey, 2026-07-02): a superseded call that reached a
    // connected state defaults to "answered" — the machine KNOWS it was answered.
    // REAL-PICKUP GUARD: a Google-screener / VM-kick connect is SIP-answered for a
    // few seconds without a human — "answered" additionally requires the connection
    // to have lasted answeredMinConnectedMs (env CX_BULK_ANSWERED_MIN_CONNECTED_MS,
    // default 10s; 0 disables). Short connects downgrade to did_not_connect.
    const supersededOutcome = applyAnsweredGuard(
      transition.previousOutcome || (next.current?.connectedAt ? "answered" : "did_not_connect"),
      next.current,
      at,
      options,
    );
    if (!sameCurrent && transition.completePrevious === true && hasTerminalWriteProof(next.current)) {
      terminalObservations.push({
        source: "active-call-switch",
        outcome: supersededOutcome,
        candidate: next.current,
      });
    }
    currentPromotion = {
      required: !sameCurrent,
      kind: transition.kind,
      // Carried for the ghost-rescue gate: a promotion that COMPLETES a previous current
      // must never be rescued (adversarial blocker, 2026-07-06: a one-tick flicker of the
      // live current + a connected ghost would force-complete the live call "answered"
      // mid-conversation and clobber current with the ghost).
      completePrevious: transition.completePrevious === true,
      candidate: transition.candidate || null,
      uii: transition.uii || null,
      activeCallSummary: match.activeCall || null,
      matchReasons: transition.matchReasons || [],
    };
    if (!sameCurrent) {
      next = reduce(next, {
        type: "current.matched",
        candidate: transition.candidate,
        uii: transition.uii,
        activeCallSummary: match.activeCall || null,
        matchReasons: transition.matchReasons,
        completePrevious: transition.completePrevious === true,
        previousOutcome: supersededOutcome,
      }, at);
    }
    // Connected latch, promotion half: if the matched call is ALREADY in a
    // connected state at promotion time, stamp it now (the per-tick latch above
    // covers later transitions on subsequent polls).
    const promotedState = str(match.activeCall?.callState).toUpperCase();
    if (next.current && !next.current.connectedAt && CONNECTED_STATES.has(promotedState)) {
      next = { ...next, current: { ...next.current, connectedAt: at.toISOString() } };
    }
  }

  const currentAfter = queueItemKey(next.current);
  const wrapChanged = Boolean(session.current?.wrap) !== Boolean(next.current?.wrap);
  const currentChanged = currentBefore !== currentAfter || str(session.current?.uii) !== str(next.current?.uii);
  const changed = releaseChanged || currentChanged || wrapChanged;

  next = withWatcherTrace(next, {
    accountId,
    activeCallCount: compactCalls.length,
    relevantActiveCallCount: relevantCalls.length,
    releasedCount: releaseDiff.released.length,
    currentReleased: Boolean(currentReleased),
    matchStatus: match.status || "unknown",
    transitionKind: transition.kind || "none",
    currentQueueItemId: next.current?.queueItemId || null,
    currentUii: next.current?.uii || null,
    terminalObservations,
    currentPromotion,
  }, at);
  traceWatcher("cx.alpha.watch.match_diagnostic", {
    sessionId: session.sessionId || null,
    agentEmail: session.agentEmail || null,
    agentExtensionId: session.agentExtensionId || null,
    accountId,
    activeCalls: compactCalls,
    relevantActiveCalls: relevantCalls,
    candidatePool: candidatePool(next).map(compactCandidate).filter(Boolean),
    current: compactCandidate(next.current),
    matchStatus: match.status || "unknown",
    matchReason: match.reason || null,
    matchedCandidate: compactCandidate(match.candidate),
    matchedActiveCall: match.activeCall || null,
    transitionKind: transition.kind || "none",
    transitionReason: transition.reason || null,
    currentReleased: Boolean(currentReleased),
    currentPromotion,
  });

  return {
    rail: "bulk_load",
    sessionId: session.sessionId || null,
    agentEmail: session.agentEmail || null,
    agentExtensionId: session.agentExtensionId || null,
    accountId,
    changed,
    before: session,
    after: next,
    activeCallCount: compactCalls.length,
    relevantActiveCallCount: relevantCalls.length,
    releasedCount: releaseDiff.released.length,
    matchStatus: match.status || "unknown",
    transitionKind: transition.kind || "none",
    currentQueueItemId: next.current?.queueItemId || null,
    currentUii: next.current?.uii || null,
    terminalObservations,
    currentPromotion,
  };
}

async function buildCxAccountActiveCallWatchPlan(input = {}) {
  const client = input.client;
  if (!client || typeof client.listActiveCalls !== "function") {
    throw new Error("buildCxAccountActiveCallWatchPlan requires client.listActiveCalls");
  }
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const watcher = input.watcher || bulkWatcher;
  const at = nowDate(input.now);
  const { byAccount, skipped } = groupBulkSessionsByAccount(sessions);
  const accounts = [];
  const projections = [];

  for (const [accountId, accountSessions] of byAccount.entries()) {
    let activeCalls = [];
    let error = null;
    const readStartedAt = Date.now();
    traceWatcher("cx.alpha.watch.account.read_started", {
      accountId,
      sessionCount: accountSessions.length,
    });
    try {
      activeCalls = await watcher.loadActiveCallsSnapshot(client, {
        product: "ACCOUNT",
        accountId,
        productId: accountId,
      });
    } catch (err) {
      error = err;
    }
    traceWatcher("cx.alpha.watch.account.read_finished", {
      accountId,
      sessionCount: accountSessions.length,
      activeCallCount: Array.isArray(activeCalls) ? activeCalls.length : 0,
      error: error ? (error.message || String(error)) : null,
      elapsedMs: Date.now() - readStartedAt,
    });

    accounts.push({
      accountId,
      sessionCount: accountSessions.length,
      activeCallCount: Array.isArray(activeCalls) ? activeCalls.length : 0,
      error: error ? (error.message || String(error)) : null,
    });

    if (error) {
      for (const session of accountSessions) {
        projections.push({
          rail: "bulk_load",
          sessionId: session.sessionId || null,
          agentEmail: session.agentEmail || null,
          accountId,
          changed: false,
          error: error.message || String(error),
        });
        traceWatcher("cx.alpha.watch.session.projected", {
          sessionId: session.sessionId || null,
          agentEmail: session.agentEmail || null,
          agentExtensionId: session.agentExtensionId || null,
          accountId,
          changed: false,
          error: error.message || String(error),
        });
      }
      continue;
    }

    for (const session of accountSessions) {
      const projection = projectBulkSessionFromAccountSnapshot(session, activeCalls, {
        watcher,
        reduce: input.reduce || reduceCxBulkLoadState,
        now: at,
        wrapTimeoutMs: input.wrapTimeoutMs,
        answeredMinConnectedMs: input.answeredMinConnectedMs,
      });
      // Bind a re-projection against THIS tick's same active-call snapshot so the apply step can
      // recover from a __v race (version-miss) by re-reading the latest session row and re-deriving
      // the release diff, instead of dropping the recomputed anchors. Non-enumerable so it never
      // leaks into the serialized plan result / logs. (#6)
      Object.defineProperty(projection, "reproject", {
        value: (freshSession) =>
          projectBulkSessionFromAccountSnapshot(freshSession, activeCalls, {
            watcher,
            reduce: input.reduce || reduceCxBulkLoadState,
            now: at,
            wrapTimeoutMs: input.wrapTimeoutMs,
        answeredMinConnectedMs: input.answeredMinConnectedMs,
          }),
        enumerable: false,
      });
      projections.push(projection);
      traceWatcher("cx.alpha.watch.session.projected", {
        ...summarizeProjection(projection),
      });
    }
  }

  return {
    checkedAt: at.toISOString(),
    accounts,
    skipped,
    projections,
    summary: {
      accountCount: accounts.length,
      sessionCount: sessions.length,
      changedCount: projections.filter((p) => p.changed).length,
      errorCount: accounts.filter((a) => a.error).length,
      skippedCount: skipped.length,
    },
  };
}

// Connected-family RingCX call states — the honest "a human (or machine) picked up" signal.
// Used by the connected latch (projection) and the ghost-rescue gate (apply).
const CONNECTED_STATES = new Set(["ACTIVE", "CONNECTED", "ONHOLD", "HOLD", "TRANSFER"]);

// WRAP JANITOR (Mickey's auto-opt-out ruling, 2026-07-06: "if someone gets lazy or something
// gets stuck there's a mechanism to clean things up"). Wrap previously held FOREVER by
// default — right for an attentive agent, but a walked-away or stuck wrap wedged the lane
// silently. New default: an unresolved wrap self-resolves after 30 minutes through the
// answered guard (source "wrap-timeout", machine-classified — the agent's click still wins
// any time before that). Explicit CX_BULK_WRAP_TIMEOUT_MS=0 restores hold-forever; any
// positive env value overrides; per-call options.wrapTimeoutMs overrides everything.
const DEFAULT_WRAP_TIMEOUT_MS = 30 * 60 * 1000;
function resolveWrapTimeoutMs(options = {}) {
  if (Number(options.wrapTimeoutMs) > 0) return Number(options.wrapTimeoutMs);
  if (options.wrapTimeoutMs === 0) return 0;
  const raw = String(process.env.CX_BULK_WRAP_TIMEOUT_MS ?? "").trim();
  if (raw !== "") {
    const env = Number(raw);
    if (Number.isFinite(env) && env >= 0) return env;
  }
  return DEFAULT_WRAP_TIMEOUT_MS;
}

// RESYNC AUDIT (Mickey, 2026-07-06, after the ghost-lead incident): the serving CAS
// refuses buffered candidates whose queue rows drifted (cancelled out-of-band, reaped to
// ready after lease expiry, re-reserved by another session). The refusal is correct — but
// silently permanent: the dead candidate stays in acceptedBuffer, the watcher re-matches
// its ghost forever (16 consecutive misses in the incident), and the session wedges with
// no signal. This audit mirrors the CAS precondition EXACTLY (state claimed/serving AND
// this session's reservation) and flags only candidates that can never pass it. It reads
// queue rows and prunes the SESSION's view — queue rows themselves are never mutated.
function deriveBufferInvalidations(session = {}, rows = []) {
  const buffer = Array.isArray(session.acceptedBuffer) ? session.acceptedBuffer : [];
  if (!buffer.length) return [];
  const sessionId = str(session.sessionId);
  const rowById = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter(Boolean)
      .map((row) => [str(row._id || row.queueItemId), row]),
  );
  const invalid = [];
  for (const candidateRow of buffer) {
    const queueItemId = str(candidateRow?.queueItemId);
    if (!queueItemId) continue;
    const row = rowById.get(queueItemId);
    if (!row) {
      invalid.push({ queueItemId, rowState: null, why: "row-missing" });
      continue;
    }
    const rowState = str(row.state).toLowerCase();
    if (!["claimed", "serving"].includes(rowState)) {
      invalid.push({
        queueItemId,
        rowState,
        why: rowState === "cancelled" ? "row-cancelled" : "row-state-unadoptable",
      });
      continue;
    }
    if (str(row.metadata?.reservationSessionId) !== sessionId) {
      invalid.push({ queueItemId, rowState, why: "reservation-foreign" });
    }
  }
  return invalid;
}

const RESYNC_SWEEP_MIN_INTERVAL_MS = 60_000;
const resyncSweepClock = new Map(); // sessionId -> last audit ms (in-memory; a restart just re-audits once)

function resyncFeatureEnabled(input = {}) {
  if (input.resyncEnabled === false) return false;
  if (input.resyncEnabled === true) return true;
  return String(process.env.CX_BULK_RESYNC_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

async function runCxAccountActiveCallWatchOnce(input = {}) {
  const sessionRepository = input.sessionRepository;
  if (!sessionRepository || typeof sessionRepository.listActiveBulkLoadSessions !== "function") {
    throw new Error("runCxAccountActiveCallWatchOnce requires sessionRepository.listActiveBulkLoadSessions");
  }
  if (typeof sessionRepository.updateBulkLoadSession !== "function") {
    throw new Error("runCxAccountActiveCallWatchOnce requires sessionRepository.updateBulkLoadSession");
  }

  const busySessionIds = new Set(
    (Array.isArray(input.skipSessionIds) ? input.skipSessionIds : [])
      .map(str)
      .filter(Boolean),
  );
  const allSessions = await sessionRepository.listActiveBulkLoadSessions({
    domain: input.domain,
    accountId: input.accountId,
    sessionId: input.sessionId,
    agentEmail: input.agentEmail,
    agentExtensionId: input.agentExtensionId,
  });
  const busySkipped = [];
  const sessions = [];
  for (const session of allSessions) {
    const sessionId = str(session?.sessionId);
    if (sessionId && busySessionIds.has(sessionId)) {
      busySkipped.push({
        sessionId,
        agentEmail: session?.agentEmail || null,
        agentExtensionId: session?.agentExtensionId || null,
        accountId: normalizeAccountId(session?.ringcx?.accountId || session?.accountId),
        reason: "session-busy",
      });
      continue;
    }
    sessions.push(session);
  }
  const plan = await buildCxAccountActiveCallWatchPlan({
    client: input.client,
    sessions,
    watcher: input.watcher,
    reduce: input.reduce,
    now: input.now,
    wrapTimeoutMs: input.wrapTimeoutMs,
        answeredMinConnectedMs: input.answeredMinConnectedMs,
  });
  traceWatcher("cx.alpha.watch.tick.summary", {
    checkedAt: plan.checkedAt || null,
    accountCount: plan.summary?.accountCount || 0,
    sessionCount: plan.summary?.sessionCount || 0,
    changedCount: plan.summary?.changedCount || 0,
    errorCount: plan.summary?.errorCount || 0,
    skippedCount: (plan.summary?.skippedCount || 0) + busySkipped.length,
    busySkippedCount: busySkipped.length,
  });

  const writes = [];
  const skipped = [...busySkipped];
  const terminalWrites = [];

  // RESYNC runner (see deriveBufferInvalidations above). Fail-closed on every edge:
  // no row reader wired / no session version to guard on / row read failed -> do
  // nothing and let a later trigger retry. The session write is version-guarded so a
  // stale snapshot can never clobber a concurrent writer — a miss just waits for the
  // next trigger. Kill switch: CX_BULK_RESYNC_ENABLED=false (default on).
  const resyncOn = resyncFeatureEnabled(input);
  async function resyncSessionBuffer(sessionState, reason) {
    if (!resyncOn) return null;
    const loadRows = input.queueStateAdapter?.loadCandidateRows;
    if (typeof loadRows !== "function") return null;
    const sessionId = str(sessionState?.sessionId);
    const buffer = Array.isArray(sessionState?.acceptedBuffer) ? sessionState.acceptedBuffer : [];
    if (!sessionId || !buffer.length) return null;
    if (sessionState.__v === undefined || sessionState.__v === null) return null;
    // Rate limit applies to EVERY trigger, not just the sweep: a persistent serving miss
    // the audit cannot cure (e.g. transient CAS failures on a healthy row) must not re-run
    // the sequential buffer read on every 1s tick (adversarial-verify finding, 2026-07-06).
    // The first miss after drift still audits immediately — one audit covers ALL dead rows.
    const lastAuditMs = resyncSweepClock.get(sessionId) || 0;
    if (Date.now() - lastAuditMs < RESYNC_SWEEP_MIN_INTERVAL_MS) return null;
    resyncSweepClock.set(sessionId, Date.now());
    const ids = buffer.map((c) => str(c?.queueItemId)).filter(Boolean);
    const rows = await loadRows(ids).catch(() => null);
    if (!Array.isArray(rows)) return null;
    const removed = deriveBufferInvalidations(sessionState, rows);
    if (!removed.length) return { pruned: 0 };
    const reduce = input.reduce || reduceCxBulkLoadState;
    const next = reduce(sessionState, { type: "buffer.invalidated", removed, reason }, input.now ? new Date(input.now) : new Date());
    const patch = { ...next };
    delete patch._id;
    delete patch.__v;
    const saved = await sessionRepository
      .updateBulkLoadSession(sessionId, patch, {
        expectedVersion: sessionState.__v,
        versionGuard: true,
      })
      .catch(() => null);
    // Pruned candidates may still have live RingCX lead copies (that IS the ghost) — kill
    // them so the lead cannot dial (again). Lead-list surgery only, fail-soft, and only
    // after the prune write landed: on a version miss the next trigger redoes both.
    let ringcxCancels = null;
    if (saved && typeof input.queueStateAdapter?.cancelPrunedCandidateCopies === "function") {
      ringcxCancels = await input.queueStateAdapter
        .cancelPrunedCandidateCopies({ session: sessionState, removed, rows })
        .catch((error) => [{ ok: false, error: error?.message || "cancel-pruned-copies-failed" }]);
    }
    traceWatcher("cx.alpha.watch.resync.pruned", {
      sessionId,
      agentEmail: sessionState.agentEmail || null,
      accountId: normalizeAccountId(sessionState.ringcx?.accountId || sessionState.accountId),
      reason,
      prunedCount: removed.length,
      removed,
      saved: Boolean(saved),
      ringcxCancels,
    });
    return { pruned: removed.length, saved: Boolean(saved), ringcxCancels };
  }

  // SYSTEM-DISPOSITION RELABEL (fail-soft, 2026-07-02): when a never-connected
  // current vanishes, RingCX knows WHY — ITS system disposition vocabulary
  // (CONGESTION / BUSY / INTERCEPT / NOANSWER / MACHINE / ABANDON). We READ their
  // value, never invent one. One bounded leadSearch filtered to the whole
  // never-connected family; the per-lead disposition field is undocumented, so we
  // try their plausible field names and TRACE the row's keys once so the first live
  // hit documents the real response shape in our logs; if the row carries no
  // readable value, one CONGESTION-only fallback probe answers the case that broke
  // the loop. The outcome ENUM stays did_not_connect either way — this is a label,
  // not routing. Any error, timeout, or non-match keeps the plain record.
  const NEVER_CONNECTED_SYSTEM_DISPOSITIONS = ["CONGESTION", "BUSY", "INTERCEPT", "NOANSWER", "MACHINE", "ABANDON"];
  async function boundedSearch(payload) {
    const timeoutSentinel = { timedOut: true };
    const timeout = new Promise((resolve) => setTimeout(() => resolve(timeoutSentinel), 2000));
    const res = await Promise.race([input.client.searchLeads(payload), timeout]);
    if (res === timeoutSentinel) return { leads: [], timedOut: true };
    return { leads: Array.isArray(res) ? res : res?.leads || res?.records || [], timedOut: false };
  }
  function readLeadSystemDisposition(lead = {}) {
    const candidates = [
      ["systemDisposition", lead.systemDisposition],
      ["lastSystemDisposition", lead.lastSystemDisposition],
      ["callResult", lead.callResult],
      ["lastCallResult", lead.lastCallResult],
      ["passDisposition", lead.passDisposition],
    ];
    for (const [field, raw] of candidates) {
      const value = str(raw).toUpperCase();
      if (NEVER_CONNECTED_SYSTEM_DISPOSITIONS.includes(value)) return { value, field };
    }
    return null;
  }
  async function lookupSystemDispositionLabel(projection, observation) {
    const traceBase = {
      sessionId: projection.sessionId,
      agentEmail: projection.agentEmail || null,
      accountId: projection.accountId || null,
      queueItemId: queueItemKey(observation.candidate) || null,
      uii: str(observation.candidate?.uii) || null,
      outcome: observation.outcome || "did_not_connect",
      source: observation.source || "active-call-release",
    };
    try {
      // Gate on the OUTCOME, not the source: a superseded short-connect (screener
      // kick followed immediately by the next call) is a never-connect wearing an
      // "active-call-switch" source — it deserves its label too. Answered rows
      // never need a lookup (connectedAt + duration already told us).
      if (observation.outcome !== "did_not_connect") return null;
      if (typeof input.client?.searchLeads !== "function") {
        traceWatcher("cx.alpha.system_disposition.lookup.skipped", {
          ...traceBase,
          reason: "missing-searchLeads-client",
        });
        return null;
      }
      const campaignId = projection.before?.ringcx?.campaignId;
      const externId = candidateExternId(observation.candidate);
      if (!campaignId || !externId) {
        traceWatcher("cx.alpha.system_disposition.lookup.skipped", {
          ...traceBase,
          campaignId: campaignId || null,
          externId: externId || null,
          reason: !campaignId ? "missing-campaign-id" : "missing-extern-id",
        });
        return null;
      }
      traceWatcher("cx.alpha.system_disposition.lookup.started", {
        ...traceBase,
        campaignId,
        externId,
        systemDispositions: NEVER_CONNECTED_SYSTEM_DISPOSITIONS,
      });
      const familyResult = await boundedSearch({ campaignId, systemDispositions: NEVER_CONNECTED_SYSTEM_DISPOSITIONS });
      const family = familyResult.leads;
      const hit = family.find((lead) => str(lead?.externId) === externId);
      traceWatcher("cx.alpha.system_disposition.lookup.family_result", {
        ...traceBase,
        campaignId,
        externId,
        timedOut: Boolean(familyResult.timedOut),
        rowCount: family.length,
        matched: Boolean(hit),
      });
      if (hit) {
        if (!lookupSystemDispositionLabel.shapeTraced) {
          lookupSystemDispositionLabel.shapeTraced = true;
          traceWatcher("cx.bulk.leadsearch.row_shape", { keys: Object.keys(hit).slice(0, 24) });
        }
        const direct = readLeadSystemDisposition(hit);
        if (direct) {
          traceWatcher("cx.alpha.system_disposition.lookup.matched", {
            ...traceBase,
            campaignId,
            externId,
            systemDisposition: direct.value,
            field: direct.field,
            matchSource: "family-filter",
          });
          return direct.value;
        }
        traceWatcher("cx.alpha.system_disposition.lookup.unlabeled_hit", {
          ...traceBase,
          campaignId,
          externId,
          reason: "matched-row-has-no-readable-system-disposition",
        });
      }
      // Response didn't say WHICH — answer the operationally-important one directly.
      const congestedResult = await boundedSearch({ campaignId, systemDispositions: ["CONGESTION"] });
      const congested = congestedResult.leads;
      const congestionMatched = congested.some((lead) => str(lead?.externId) === externId);
      traceWatcher("cx.alpha.system_disposition.lookup.congestion_result", {
        ...traceBase,
        campaignId,
        externId,
        timedOut: Boolean(congestedResult.timedOut),
        rowCount: congested.length,
        matched: congestionMatched,
        systemDisposition: congestionMatched ? "CONGESTION" : null,
      });
      return congestionMatched ? "CONGESTION" : null;
    } catch (error) {
      traceWatcher("cx.alpha.system_disposition.lookup.failed", {
        ...traceBase,
        error: error?.message || "lookup-failed",
      });
      return null; // fail-soft: the plain did_not_connect record stands
    }
  }

  async function persistTerminalObservations(projection) {
    for (const observation of projection.terminalObservations || []) {
      if (typeof input.outcomeAdapter?.persistTerminalOutcome !== "function") continue;
      if (!hasTerminalWriteProof(observation.candidate)) {
        traceWatcher("cx.alpha.terminal.observation.skipped", {
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          accountId: projection.accountId || null,
          reason: "missing-queue-item-or-uii",
          queueItemId: queueItemKey(observation.candidate) || null,
          uii: str(observation.candidate?.uii) || null,
          source: observation.source || "active-call-release",
        });
        skipped.push({
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          reason: "missing-queue-item-or-uii",
          queueItemId: queueItemKey(observation.candidate) || null,
          uii: str(observation.candidate?.uii) || null,
        });
        continue;
      }
      const systemDisposition = await lookupSystemDispositionLabel(projection, observation);
      await input.outcomeAdapter.persistTerminalOutcome({
        session: projection.before,
        candidate: observation.candidate,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
        eventType: "terminal",
        ...(systemDisposition ? { systemDisposition } : {}),
      });
      traceWatcher("cx.alpha.terminal.outbox_insert.finished", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        queueItemId: queueItemKey(observation.candidate),
        uii: str(observation.candidate?.uii) || null,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
        systemDisposition: systemDisposition || null,
      });
      terminalWrites.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        queueItemId: queueItemKey(observation.candidate),
        uii: str(observation.candidate?.uii) || null,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
        systemDisposition: systemDisposition || null,
      });
    }
  }

  const runSessionApply = typeof input.applySessionMutation === "function"
    ? input.applySessionMutation
    : async (_sessionId, work) => work();

  // #6: bounded re-read + re-project + retry on a version-miss, scoped to the safe pure-release
  // path. Returns { saved, projection, write } on success, or { saved:null, reason } otherwise.
  // No-ops (returns plain "version-miss") when the runtime did not inject loadLatestState or the
  // projection carries no reproject binding, preserving the legacy single-shot behavior.
  async function retryReleaseProjectionOnVersionMiss(projection, maxAttempts = 2) {
    if (typeof input.loadLatestState !== "function" || typeof projection.reproject !== "function") {
      return { saved: null, reason: "version-miss" };
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const latest = await input.loadLatestState(projection.sessionId);
      if (!latest) return { saved: null, reason: "version-miss-session-gone" };
      if (typeof input.isSessionBusy === "function" && input.isSessionBusy(projection.sessionId)) {
        return { saved: null, reason: "version-miss-busy" };
      }
      const fresh = projection.reproject(latest);
      if (!fresh || !fresh.changed) return { saved: null, reason: "version-miss-no-change" };
      // A fresh promotion would need a serving-ownership stamp we have NOT taken here; bail rather
      // than write a current the queue row isn't stamped serving for. The pure release/terminal
      // path (no required promotion) is safe to re-drive.
      if (fresh.currentPromotion && fresh.currentPromotion.required) {
        return { saved: null, reason: "version-miss-needs-promotion" };
      }
      const writeOptions = buildVersionGuardOptions(latest);
      const patch = { ...fresh.after };
      delete patch._id;
      delete patch.__v;
      const saved = await sessionRepository.updateBulkLoadSession(projection.sessionId, patch, writeOptions);
      if (saved) {
        return {
          saved,
          projection: fresh,
          write: {
            sessionId: projection.sessionId,
            agentEmail: projection.agentEmail || null,
            accountId: projection.accountId || null,
            transitionKind: fresh.transitionKind || null,
            currentQueueItemId: saved.current?.queueItemId || fresh.currentQueueItemId || null,
            currentUii: saved.current?.uii || fresh.currentUii || null,
            releasedCount: fresh.releasedCount || 0,
            retriedVersionMiss: true,
          },
        };
      }
      // still racing — loop and re-read against an even fresher row
    }
    return { saved: null, reason: "version-miss-exhausted" };
  }

  async function applyProjection(projection) {
    const promotion = projection.currentPromotion || null;
    const promotionRequired = Boolean(
      promotion && promotion.required && typeof input.queueStateAdapter?.markCandidateServing === "function",
    );
    // Only pay for a latest-state read when we are about to take a Mongo side-effect (the serving
    // ownership stamp) BEFORE the version-guarded session write — that is the one spot where a stale
    // projection can orphan a queue-row serving/wrapUpRequired stamp the session never adopts. Pure
    // release/version-guarded writes are already protected by the write's own version guard. (#10)
    const latest = promotionRequired && typeof input.loadLatestState === "function"
      ? await input.loadLatestState(projection.sessionId)
      : null;
    const eligibility = describeBulkLoadMutationEligibility({
      session: projection.before,
      latest,
      busy: typeof input.isSessionBusy === "function" && input.isSessionBusy(projection.sessionId),
    });
    if (!eligibility.ok) {
      traceWatcher("cx.alpha.watch.session.skipped", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        agentExtensionId: projection.agentExtensionId || null,
        accountId: projection.accountId || null,
        reason: eligibility.reason === "session-busy"
          ? "session-busy-apply"
          : eligibility.reason === "stale-projection"
            ? "stale-projection-apply"
            : eligibility.reason,
      });
      skipped.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        reason: eligibility.reason === "session-busy"
          ? "session-busy-apply"
          : eligibility.reason === "stale-projection"
            ? "stale-projection-apply"
            : eligibility.reason,
      });
      return;
    }
    if (promotionRequired) {
      const served = await input.queueStateAdapter
        .markCandidateServing({
          session: projection.before,
          candidate: promotion.candidate,
          uii: promotion.uii,
          activeCallSummary: promotion.activeCallSummary || null,
          matchReasons: promotion.matchReasons || [],
        })
        .catch(() => null);
      let servingMethod = "markCandidateServing";
      if (!served) {
        // GHOST POLICY (Mickey's ruling, 2026-07-06). A refused adoption whose call a human
        // (or machine) actually PICKED UP is a live prospect stranded outside the app. Try
        // to RESCUE it (adapter re-checks compliance eligibility and re-claims the row) so
        // the agent works the call with buttons in OUR app — human → work it, voicemail →
        // click Voicemail. If the rescue is refused (DNC/foreign/ineligible) there is no
        // compliant way to work the call: HANG IT UP (works on ACTIVE legs; documented
        // no-op on ringing) so the agent is freed without touching CX. Ringing ghosts are
        // never rescued or hung up — RingCX ring-out advances them on its own.
        const ghostCallState = str(promotion.activeCallSummary?.callState).toUpperCase();
        const ghostConnected = CONNECTED_STATES.has(ghostCallState);
        // SWITCH GUARD (adversarial blocker, 2026-07-06): a promotion that completes a
        // previous current is NEVER rescued. If the previous current's call merely
        // flickered out of one snapshot, adopting the ghost would persist a false
        // "answered" terminal for a LIVE conversation and make it invisible forever.
        // Refusing here restores the pre-rescue harmlessness (miss, no write); once the
        // agent resolves their current (click/wrap end), the next tick promotes the ghost
        // with no previous to complete and the rescue proceeds — self-sequencing.
        const rescueSafe = ghostConnected && promotion.completePrevious !== true;
        let rescueResult = null;
        if (resyncOn && rescueSafe && typeof input.queueStateAdapter?.rescueCandidateServing === "function") {
          rescueResult = await input.queueStateAdapter
            .rescueCandidateServing({
              session: projection.before,
              candidate: promotion.candidate,
              uii: promotion.uii,
              activeCallSummary: promotion.activeCallSummary || null,
              matchReasons: promotion.matchReasons || [],
            })
            .catch(() => null);
        }
        const rescued = rescueResult?.adopted || null;
        if (rescued) {
          servingMethod = "rescueCandidateServing";
          traceWatcher("cx.alpha.watch.serving_stamp.rescued", {
            sessionId: projection.sessionId,
            agentEmail: projection.agentEmail || null,
            accountId: projection.accountId || null,
            currentQueueItemId: projection.currentQueueItemId || null,
            currentUii: projection.currentUii || null,
            ghostCallState,
          });
        } else {
          // HANGUP GATE (Mickey's flicker question, 2026-07-06): only a DEFINITIVE refusal
          // (contact-blocked / foreign-owned / row confirmed gone) may end the leg. A
          // transient refusal — read failure, healthy-row race, eligibility outage, rescue
          // CAS miss — hangs up NOTHING and simply retries on the next tick; a Mongo blip
          // must never kill a live conversation.
          const definitiveRefusal = Boolean(rescueResult?.refused && rescueResult.definitive === true);
          if (resyncOn && rescueSafe && definitiveRefusal && typeof input.queueStateAdapter?.hangupGhostCall === "function") {
            const hangup = await input.queueStateAdapter
              .hangupGhostCall({ uii: promotion.uii })
              .catch(() => null);
            traceWatcher("cx.alpha.watch.ghost_call.hangup", {
              sessionId: projection.sessionId,
              agentEmail: projection.agentEmail || null,
              accountId: projection.accountId || null,
              currentQueueItemId: projection.currentQueueItemId || null,
              currentUii: projection.currentUii || null,
              ghostCallState,
              rescueRefusal: rescueResult?.refused || null,
              ok: hangup ? hangup.ok !== false : false,
              detail: hangup || null,
            });
          }
          // The departing call's terminal outcome is INDEPENDENT of whether the incoming candidate
          // can be adopted — flush co-attached terminal observations before bailing, or a real,
          // already-ended call (queueItemId + UII) loses its did_not_connect and the lead's attempt
          // accounting is corrupted. persistTerminalObservations self-guards each obs with
          // hasTerminalWriteProof, and this branch returns before the line-~579 flush so there is no
          // double-write. The session state patch (B's promotion) is correctly NOT written here. (#7)
          await persistTerminalObservations(projection);
          traceWatcher("cx.alpha.watch.serving_stamp.missed", {
            sessionId: projection.sessionId,
            agentEmail: projection.agentEmail || null,
            accountId: projection.accountId || null,
            currentQueueItemId: projection.currentQueueItemId || null,
            currentUii: projection.currentUii || null,
            ghostCallState,
            rescueRefusal: rescueResult?.refused || null,
          });
          skipped.push({
            sessionId: projection.sessionId,
            agentEmail: projection.agentEmail || null,
            reason: "serving-ownership-stamp-miss",
            currentQueueItemId: projection.currentQueueItemId || null,
            currentUii: projection.currentUii || null,
          });
          // RESYNC Trigger A — DEFINITIVELY-refused connected ghosts only (adversarial
          // blocker #2, 2026-07-06): the audit's "unadoptable" classifier (not claimed/
          // serving) flags exactly the rows the rescue calls rescuable (ready/cancelled),
          // so pruning on a NON-definitive refusal would delete the candidate the promised
          // next-tick retry needs — one transient blip and the answered human is stranded
          // forever, unrescued AND unhung-up. Non-definitive → no prune, retry next tick.
          // RINGING ghosts also never prune here (the rescue window). Never-connects and
          // abandoned retries are swept by Trigger B once the call leaves the snapshot.
          if (ghostConnected && definitiveRefusal) {
            await resyncSessionBuffer(latest || projection.before, "serving-stamp-miss").catch(() => null);
          }
          return;
        }
      }
      traceWatcher("cx.alpha.watch.serving_stamp.accepted", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        currentQueueItemId: projection.currentQueueItemId || null,
        currentUii: projection.currentUii || null,
        servingMethod,
      });
    }

    let after = projection.after;
    if (typeof input.beforePersist === "function") {
      after = await input.beforePersist({
        projection: { ...projection, after },
        state: after,
      });
    }
    const patch = { ...after };
    delete patch._id;
    delete patch.__v;
    const writeOptions = eligibility.writeOptions || {};
    const saved = await sessionRepository.updateBulkLoadSession(projection.sessionId, patch, writeOptions);
    if (!saved) {
      // A concurrent writer bumped __v between our read and this write. Re-read the latest row and
      // re-PROJECT against THIS tick's same active-call snapshot, then retry the guarded write, so a
      // lead that went active->released entirely inside the race gap is still counted — its terminal
      // observation (and the recomputed release anchors) would otherwise be dropped. We never
      // blind-resend the stale patch (that would clobber the very writer the version guard protects
      // against); the retry only re-drives the pure release/terminal path. (#6)
      const retried = await retryReleaseProjectionOnVersionMiss(projection);
      if (retried.saved) {
        writes.push(retried.write);
        traceWatcher("cx.alpha.watch.version_miss.recovered", retried.write);
        await persistTerminalObservations(retried.projection);
      } else {
        traceWatcher("cx.alpha.watch.version_miss.unrecovered", {
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          accountId: projection.accountId || null,
          reason: retried.reason || "version-miss",
          expectedVersion: writeOptions.expectedVersion ?? null,
          expectedUpdatedAt: writeOptions.expectedUpdatedAt ?? null,
        });
        skipped.push({
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          accountId: projection.accountId || null,
          reason: retried.reason || "version-miss",
          expectedVersion: writeOptions.expectedVersion ?? null,
          expectedUpdatedAt: writeOptions.expectedUpdatedAt ?? null,
        });
      }
    } else {
      writes.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        transitionKind: projection.transitionKind || null,
        currentQueueItemId: saved.current?.queueItemId || projection.currentQueueItemId || null,
        currentUii: saved.current?.uii || projection.currentUii || null,
        releasedCount: projection.releasedCount || 0,
      });
      traceWatcher("cx.alpha.watch.session.persisted", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        transitionKind: projection.transitionKind || null,
        currentQueueItemId: saved.current?.queueItemId || projection.currentQueueItemId || null,
        currentUii: saved.current?.uii || projection.currentUii || null,
        releasedCount: projection.releasedCount || 0,
      });
      await persistTerminalObservations(projection);
    }
  }

  for (const projection of plan.projections) {
    if (!projection.changed || projection.error || !projection.sessionId) continue;
    await runSessionApply(projection.sessionId, () => applyProjection(projection));
  }

  // RESYNC Trigger B: quiet-drift sweep. A reaped batch is RC-unloaded (post ghost-guard
  // fix), so no ghost ever dials and Trigger A never fires — the session just sits frozen
  // holding a dead buffer. Sweep sessions that project NO current while still holding
  // buffered candidates, at most once a minute each, under the same per-session serializer
  // as the apply step. Healthy claimed rows audit to zero prunes — a cheap indexed read.
  if (resyncOn) {
    const sweepNowMs = Date.now();
    for (const projection of plan.projections) {
      if (projection.error || !projection.sessionId) continue;
      if (projection.currentQueueItemId) continue;
      const before = projection.before;
      if (!Array.isArray(before?.acceptedBuffer) || before.acceptedBuffer.length === 0) continue;
      const lastAuditMs = resyncSweepClock.get(projection.sessionId) || 0;
      if (sweepNowMs - lastAuditMs < RESYNC_SWEEP_MIN_INTERVAL_MS) continue;
      await runSessionApply(projection.sessionId, () => resyncSessionBuffer(before, "idle-drift-sweep").catch(() => null));
    }
    // Clock hygiene: only on an UNSCOPED run, and keyed off ALL listed sessions (incl.
    // busy-skipped) — a scoped invocation or a busy tick must not purge other sessions'
    // stamps and reset their rate limit (adversarial-verify finding, 2026-07-06).
    const runScoped = Boolean(input.sessionId || input.agentEmail || input.agentExtensionId || input.accountId || input.domain);
    if (!runScoped) {
      const activeSessionIds = new Set(allSessions.map((s) => str(s?.sessionId)).filter(Boolean));
      for (const key of resyncSweepClock.keys()) {
        if (!activeSessionIds.has(key)) resyncSweepClock.delete(key);
      }
    }
  }

  const result = {
    ...plan,
    applied: {
      writeCount: writes.length,
      writes,
      skippedCount: skipped.length,
      skipped,
      terminalWriteCount: terminalWrites.length,
      terminalWrites,
    },
  };
  traceWatcher("cx.alpha.watch.tick.applied", {
    checkedAt: result.checkedAt || null,
    writeCount: writes.length,
    skippedCount: skipped.length,
    terminalWriteCount: terminalWrites.length,
    writeSamples: writes.slice(0, 5),
    skippedSamples: skipped.slice(0, 5),
    terminalWriteSamples: terminalWrites.slice(0, 5),
  });
  return result;
}

module.exports = {
  buildCxAccountActiveCallWatchPlan,
  compactActiveCall,
  compactActiveCalls,
  deriveBufferInvalidations,
  groupBulkSessionsByAccount,
  projectBulkSessionFromAccountSnapshot,
  resolveWrapTimeoutMs, // exported for pins; pure
  runCxAccountActiveCallWatchOnce,
};
