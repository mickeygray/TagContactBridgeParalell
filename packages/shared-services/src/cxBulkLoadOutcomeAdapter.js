"use strict";

// Outcome adapter for the bulk_load rail — the SINGLE writer of terminal outcomes.
//
// "Complete once" is true by the idempotency key, not by a guard flag on the
// session: every terminal path (manual disposition, auto-advance, kill cleanup)
// funnels through persistTerminalOutcome. The key is `queueItemId:uii` — UII is the
// RingCX call identity, so a released call is uniquely (queueItemId, uii) and two
// DISTINCT dial attempts on the same queue item (different UIIs) do NOT collapse
// (M11 gate 3). A no-UII terminal (skip / manual-reset with no live call) falls back
// to (sessionId, queueItemId, eventType).
//
// Pure builders (makeOutcomeIdemKey, buildCadenceEvent) test with zero mocks. The
// durable write is injected (recordCadenceEvent) so this adapter never reaches into
// Mongo/metrics itself. Idempotency belongs to the durable outbox unique key, not
// an in-memory Set in the live process.

function str(value) {
  return String(value == null ? "" : value).trim();
}

function candidateKey(candidate) {
  if (!candidate) return "";
  return str(candidate.queueItemId || candidate.id || candidate._id);
}

// PURE. Stable idempotency key for one terminal write. UII (the call identity) keys it
// when present so distinct dial attempts on the same queue item never collapse; a no-UII
// terminal falls back to (sessionId, queueItemId, eventType). (M11 gate 3.)
function makeOutcomeIdemKey({ sessionId, queueItemId, uii = null, caseId = null, eventType = "terminal" } = {}) {
  const qid = str(queueItemId);
  const u = str(uii);
  const kind = str(eventType) || "terminal";
  if (u) {
    const base = qid ? `${qid}:${u}` : `${str(sessionId)}:uii:${u}`;
    return kind === "terminal" ? base : `${base}:${kind}`;
  }
  const caseKey = str(caseId);
  if (!qid && caseKey) return `${str(sessionId)}:case:${caseKey}:${kind}`;
  return `${str(sessionId)}:${qid}:${kind}`;
}

// PURE. Narrow projection of a completion into the cadence/metric event shape the
// existing finalizers consume. No I/O, no derived business decisions.
function buildCadenceEvent({ session = {}, candidate = {}, outcome = null, source = null, at = null } = {}) {
  const durationSec = Number(
    candidate.durationSec ??
      candidate.durationSeconds ??
      candidate.activeCallSummary?.durationSec ??
      candidate.activeCallSummary?.durationSeconds,
  );
  return {
    sessionId: str(session.sessionId) || null,
    domain: session.domain || candidate.domain || null,
    agentEmail: session.agentEmail || (session.agent && session.agent.email) || null,
    agentName: session.agentName || (session.agent && session.agent.name) || null,
    queueItemId: candidateKey(candidate) || null,
    caseId: candidate.caseId != null ? candidate.caseId : null,
    externId: str(candidate.externId || (candidate.ringcx && candidate.ringcx.externId)) || null,
    uii: str(candidate.uii) || null,
    phone: str(candidate.phone || candidate.leadPhone || candidate.activeCallSummary?.phone) || null,
    phoneLast4: str(candidate.phoneLast4) || null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    coachSessionId: str(candidate.coachSessionId || candidate.liveCoachSessionId) || null,
    callSummary: str(candidate.callSummary || candidate.summary) || null,
    interviewSnapshotWorkflowId: str(candidate.interviewSnapshotWorkflowId) || null,
    outcome,
    source: source || null,
    at: at || null,
  };
}

// Build the single-writer adapter. `deps` supplies the durable effect:
//   recordCadenceEvent(event) -> Promise<object|null>  insert-once + replayable write
function createCxBulkLoadOutcomeAdapter(deps = {}) {
  const { recordCadenceEvent } = deps;
  if (typeof recordCadenceEvent !== "function") {
    throw new Error("createCxBulkLoadOutcomeAdapter requires recordCadenceEvent");
  }

  // Write a terminal outcome exactly once. Returns what happened; never throws on
  // a duplicate (a re-fire is a no-op, not an error).
  async function persistTerminalOutcome(input = {}) {
    const { session = {}, candidate = {}, outcome = null, source = null, eventType = "terminal" } = input;
    const at = (input.now instanceof Date ? input.now : (input.now ? new Date(input.now) : new Date())).toISOString();
    const idemKey = makeOutcomeIdemKey({
      sessionId: session.sessionId,
      queueItemId: candidateKey(candidate),
      uii: candidate.uii,
      caseId: candidate.caseId,
      eventType,
    });

    const cadenceEvent = {
      ...buildCadenceEvent({ session, candidate, outcome, source, at }),
      idemKey,
    };
    const result = await recordCadenceEvent(cadenceEvent);
    return {
      written: result != null && result.written !== false,
      idemKey,
      reason: result?.reason || null,
      cadenceEvent,
      result,
    };
  }

  return { persistTerminalOutcome };
}

module.exports = {
  makeOutcomeIdemKey,
  buildCadenceEvent,
  createCxBulkLoadOutcomeAdapter,
};
