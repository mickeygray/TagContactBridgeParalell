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
  const currentReleased = watcher.deriveCurrentRelease
    ? watcher.deriveCurrentRelease({
        current: next.current,
        prevActiveCalls: session.trace?.prevActiveCalls || [],
        activeCalls: relevantCalls,
      })
    : null;
  if (currentReleased) {
    if (hasTerminalWriteProof(currentReleased)) {
      terminalObservations.push({
        source: "active-call-release",
        outcome: "did_not_connect",
        candidate: currentReleased,
      });
    }
    next = reduce(next, {
      type: "current.released",
      outcome: "did_not_connect",
      reason: "ringcx-current-released",
      reviewHoldUntil: buildReviewHoldUntil(options, at),
      reviewHoldReason: "ringcx-current-released",
    }, at);
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
    if (!sameCurrent && transition.completePrevious === true && hasTerminalWriteProof(next.current)) {
      terminalObservations.push({
        source: "active-call-switch",
        outcome: transition.previousOutcome || "did_not_connect",
        candidate: next.current,
      });
    }
    currentPromotion = {
      required: !sameCurrent,
      kind: transition.kind,
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
        previousOutcome: transition.previousOutcome,
      }, at);
    }
  }

  const currentAfter = queueItemKey(next.current);
  const currentChanged = currentBefore !== currentAfter || str(session.current?.uii) !== str(next.current?.uii);
  const changed = releaseChanged || currentChanged;

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
      await input.outcomeAdapter.persistTerminalOutcome({
        session: projection.before,
        candidate: observation.candidate,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
        eventType: "terminal",
      });
      traceWatcher("cx.alpha.terminal.outbox_insert.finished", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        queueItemId: queueItemKey(observation.candidate),
        uii: str(observation.candidate?.uii) || null,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
      });
      terminalWrites.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        queueItemId: queueItemKey(observation.candidate),
        uii: str(observation.candidate?.uii) || null,
        outcome: observation.outcome || "did_not_connect",
        source: observation.source || "active-call-release",
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
      if (!served) {
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
        });
        skipped.push({
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          reason: "serving-ownership-stamp-miss",
          currentQueueItemId: projection.currentQueueItemId || null,
          currentUii: projection.currentUii || null,
        });
        return;
      }
      traceWatcher("cx.alpha.watch.serving_stamp.accepted", {
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        currentQueueItemId: projection.currentQueueItemId || null,
        currentUii: projection.currentUii || null,
        servingMethod: "markCandidateServing",
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
  groupBulkSessionsByAccount,
  projectBulkSessionFromAccountSnapshot,
  runCxAccountActiveCallWatchOnce,
};
