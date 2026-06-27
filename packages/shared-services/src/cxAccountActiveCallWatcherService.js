"use strict";

const bulkWatcher = require("./cxBulkLoadActiveCallWatcher");
const { reduceCxBulkLoadState } = require("./cxBulkLoadStateMachine");
const { describeBulkLoadMutationEligibility } = require("./cxBulkLoadMutationEligibility");

function str(value) {
  return String(value == null ? "" : value).trim();
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

function candidatePool(state = {}, extraCandidates = []) {
  const pool = [];
  if (Array.isArray(state.acceptedBuffer)) pool.push(...state.acceptedBuffer);
  if (state.current) pool.push(state.current);
  if (Array.isArray(extraCandidates)) pool.push(...extraCandidates);
  return pool;
}

function candidateExternId(candidate = {}) {
  return str(candidate.externId || candidate.ringcx?.externId);
}

function findManualStartedActiveCall(current = null, compactCalls = []) {
  if (!current || current.uii || current.manualStartPending !== true) return null;
  const targetPhone = normalizePhoneDigits(current.phone);
  if (!targetPhone) return null;
  const matches = (Array.isArray(compactCalls) ? compactCalls : []).filter((call) => {
    if (!call?.uii) return false;
    const ani = normalizePhoneDigits(call.ani);
    const dnis = normalizePhoneDigits(call.dnis);
    return ani === targetPhone || dnis === targetPhone;
  });
  if (matches.length !== 1) return null;
  return {
    ...matches[0],
    externId: candidateExternId(current) || queueItemKey(current),
    manualStartMatched: true,
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
  const externalCandidates = Array.isArray(options.externalCandidates) ? options.externalCandidates : [];
  const pool = candidatePool(session, externalCandidates);
  const candidateExternIds = new Set(pool.map(candidateExternId).filter(Boolean));
  let relevantCalls = compactCalls.filter((call) => call.externId && candidateExternIds.has(call.externId));
  const manualStartedCall = findManualStartedActiveCall(session.current, compactCalls);
  const currentBefore = queueItemKey(session.current);
  const currentUiiBefore = str(session.current?.uii);
  if (manualStartedCall) {
    const alreadyIncluded = relevantCalls.some((call) => call.uii && call.uii === manualStartedCall.uii);
    relevantCalls = alreadyIncluded ? relevantCalls : [...relevantCalls, manualStartedCall];
  }

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
      externalCandidateCount: externalCandidates.length,
      matchStatus: "held-review",
      transitionKind: "held-review",
      currentQueueItemId: next.current?.queueItemId || null,
      currentUii: next.current?.uii || null,
      reviewHoldUntil: next.reviewHoldUntil || null,
      terminalObservations,
      currentPromotion: null,
    }, at);

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

  const match = watcher.matchActiveCallToCandidates(relevantCalls, candidatePool(next, externalCandidates));
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
    externalCandidateCount: externalCandidates.length,
    matchStatus: match.status || "unknown",
    transitionKind: transition.kind || "none",
    currentQueueItemId: next.current?.queueItemId || null,
    currentUii: next.current?.uii || null,
    terminalObservations,
    currentPromotion,
  }, at);

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
    try {
      activeCalls = await watcher.loadActiveCallsSnapshot(client, {
        product: "ACCOUNT",
        accountId,
        productId: accountId,
      });
    } catch (err) {
      error = err;
    }

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
      }
      continue;
    }

    for (const session of accountSessions) {
      let externalCandidates = [];
      if (typeof input.resolveExternalCandidates === "function") {
        externalCandidates = await input.resolveExternalCandidates({
          session,
          activeCalls,
          now: at,
        });
      }
      projections.push(projectBulkSessionFromAccountSnapshot(session, activeCalls, {
        watcher,
        reduce: input.reduce || reduceCxBulkLoadState,
        externalCandidates,
        now: at,
      }));
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
    resolveExternalCandidates: input.resolveExternalCandidates,
    now: input.now,
  });

  const writes = [];
  const skipped = [...busySkipped];
  const terminalWrites = [];

  async function persistTerminalObservations(projection) {
    for (const observation of projection.terminalObservations || []) {
      if (typeof input.outcomeAdapter?.persistTerminalOutcome !== "function") continue;
      if (!hasTerminalWriteProof(observation.candidate)) {
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

  async function applyProjection(projection) {
    const eligibility = describeBulkLoadMutationEligibility({
      session: projection.before,
      busy: typeof input.isSessionBusy === "function" && input.isSessionBusy(projection.sessionId),
    });
    if (!eligibility.ok) {
      skipped.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        reason: eligibility.reason === "session-busy" ? "session-busy-apply" : eligibility.reason,
      });
      return;
    }
    const promotion = projection.currentPromotion || null;
    if (promotion && promotion.required && typeof input.queueStateAdapter?.markCandidateServing === "function") {
      const adopted = promotion.candidate?.adoption?.source === "ringcx-active-external-id";
      const servingMethod =
        adopted && typeof input.queueStateAdapter.markAdoptedCandidateServing === "function"
          ? "markAdoptedCandidateServing"
          : "markCandidateServing";
      const served = await input.queueStateAdapter
        [servingMethod]({
          session: projection.before,
          candidate: promotion.candidate,
          uii: promotion.uii,
          activeCallSummary: promotion.activeCallSummary || null,
          matchReasons: promotion.matchReasons || [],
        })
        .catch(() => null);
      if (!served) {
        skipped.push({
          sessionId: projection.sessionId,
          agentEmail: projection.agentEmail || null,
          reason: "serving-ownership-stamp-miss",
          currentQueueItemId: projection.currentQueueItemId || null,
          currentUii: projection.currentUii || null,
          adopted,
        });
        return;
      }
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
      skipped.push({
        sessionId: projection.sessionId,
        agentEmail: projection.agentEmail || null,
        accountId: projection.accountId || null,
        reason: "version-miss",
        expectedVersion: writeOptions.expectedVersion ?? null,
        expectedUpdatedAt: writeOptions.expectedUpdatedAt ?? null,
      });
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
      await persistTerminalObservations(projection);
    }
  }

  for (const projection of plan.projections) {
    if (!projection.changed || projection.error || !projection.sessionId) continue;
    await runSessionApply(projection.sessionId, () => applyProjection(projection));
  }

  return {
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
}

module.exports = {
  buildCxAccountActiveCallWatchPlan,
  compactActiveCall,
  compactActiveCalls,
  groupBulkSessionsByAccount,
  projectBulkSessionFromAccountSnapshot,
  runCxAccountActiveCallWatchOnce,
};
