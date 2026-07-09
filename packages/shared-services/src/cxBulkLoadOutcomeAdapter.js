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

// PURE. Read-side counterpart to makeOutcomeIdemKey. Given a queue row as the reservation
// reconciler sees it, produce the FULL set of idemKeys any terminal write for that row could
// have used, so an exact `idemKey: { $in: keys }` lookup against the outbox is a SUPERSET of
// whatever was actually written. Mirrors every branch of makeOutcomeIdemKey — the UII-bearing
// (`queueItemId:uii` / `sessionId:uii:uii`) shapes AND the no-UII terminal shapes
// (`sessionId:queueItemId:terminal` / `sessionId:case:caseId:terminal`) that skip and
// kill-manual-reset writes produce. The reconciler previously hand-rolled only `queueItemId:uii`
// and short-circuited when queueItemId was set, so a no-UII terminal row went unmatched and an
// already-dispositioned lead was RELEASED back to ready (re-dialed). (#12)
function buildTerminalEvidenceKeys(row = {}) {
  const metadata = row && typeof row.metadata === "object" && row.metadata ? row.metadata : {};
  const queueItemId = str(row && (row._id || row.queueItemId));
  const sessionId = str(
    metadata.reservationSessionId
      || (row && row.sessionId)
      || metadata.bulkLoadSessionId
      || metadata.lastBulkLoadSessionId,
  );
  const caseKey = str(row && row.caseId);
  const uiis = [
    row && row.uii,
    metadata.lastQueueAttemptUii,
    metadata.lastDialExecutionUii,
    metadata.lastRingcxActiveCall && metadata.lastRingcxActiveCall.uii,
    metadata.lastRingcxActiveCall && metadata.lastRingcxActiveCall.callId,
    metadata.lastRingcxActiveCall && metadata.lastRingcxActiveCall.sessionId,
  ]
    .map(str)
    .filter(Boolean);
  const keys = new Set();
  for (const uii of uiis) {
    const key = makeOutcomeIdemKey({ sessionId, queueItemId, uii, caseId: row && row.caseId, eventType: "terminal" });
    if (key) keys.add(key);
  }
  // The no-UII terminal key. Guard against the degenerate `sessionId::terminal` (no qid AND no
  // case) so we never emit a key broad enough to match an unrelated row.
  if (queueItemId || caseKey) {
    const key = makeOutcomeIdemKey({ sessionId, queueItemId, caseId: row && row.caseId, eventType: "terminal" });
    if (key) keys.add(key);
  }
  return [...keys];
}

// PURE (#4). Build a DNC rectification outbox row — a SEPARATE durable record, NOT a mutation of the
// in-flight terminal row the drain may already be replaying. Keyed with eventType "review-dnc" so it
// can never collide with the original terminal idemKey (`queueItemId:uii`), and a repeated review
// dedups via insertOnce's unique index. It copies the original terminal row's payload (the proven
// drain shape) and flips outcome -> "dnc", so the same drain machinery routes the DNC to Logics —
// giving the correction a guaranteed lane even AFTER the original terminal row drained. Falls back to
// a minimal payload when no original row is found.
function buildReviewCorrectionRow({
  sessionId,
  queueItemId,
  uii,
  original = null,
  domain = null,
  agentEmail = null,
  caseId = null,
  at = null,
} = {}) {
  const ts = at || new Date().toISOString();
  const basePayload = original && original.payload && typeof original.payload === "object" ? original.payload : null;
  const pick = (...vals) => {
    for (const v of vals) {
      if (v != null && !(typeof v === "string" && v.trim() === "")) return v;
    }
    return null;
  };
  const resolvedDomain = pick(domain, original && original.domain, basePayload && basePayload.domain);
  const resolvedCaseId = pick(
    caseId,
    original && original.caseId,
    basePayload && basePayload.caseId,
  );
  const resolvedAgentEmail = pick(original && original.agentEmail, basePayload && basePayload.agentEmail, agentEmail);
  const externId = pick(original && original.externId, basePayload && basePayload.externId);
  const overrides = {
    queueItemId,
    uii,
    domain: resolvedDomain,
    caseId: resolvedCaseId,
    externId,
    outcome: "dnc",
    source: "agent-auto-review",
    reviewSource: "agent-auto-review",
    reviewedAt: ts,
    at: ts,
  };
  const payload = basePayload
    ? { ...basePayload, ...overrides }
    : { ...overrides, agentEmail: resolvedAgentEmail };
  return {
    idemKey: makeOutcomeIdemKey({ sessionId, queueItemId, uii, eventType: "review-dnc" }),
    sessionId,
    rail: "bulk_load",
    domain: resolvedDomain,
    queueItemId,
    uii,
    caseId: resolvedCaseId,
    agentEmail: resolvedAgentEmail,
    externId,
    outcome: "dnc",
    source: "agent-auto-review",
    payload,
  };
}

// PURE. Narrow projection of a completion into the cadence/metric event shape the
// existing finalizers consume. No I/O, no derived business decisions.
function buildCadenceEvent({
  session = {},
  candidate = {},
  outcome = null,
  source = null,
  at = null,
  systemDisposition = null,
  badNumber = false,
  badNumberReason = null,
} = {}) {
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
    name: str(
      candidate.name ||
        candidate.prospectName ||
        candidate.contactName ||
        candidate.fullName ||
        candidate.payloadSnapshot?.name,
    ) || null,
    externId: str(candidate.externId || (candidate.ringcx && candidate.ringcx.externId)) || null,
    uii: str(candidate.uii) || null,
    phone: str(candidate.phone || candidate.leadPhone || candidate.activeCallSummary?.phone) || null,
    phoneLast4: str(candidate.phoneLast4) || null,
    sourceName: str(
      candidate.sourceName ||
        candidate.intakeSource ||
        candidate.payloadSnapshot?.sourceName ||
        candidate.payloadSnapshot?.intakeSource,
    ) || null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    coachSessionId: str(candidate.coachSessionId || candidate.liveCoachSessionId) || null,
    callSummary: str(candidate.callSummary || candidate.summary) || null,
    interviewSnapshotWorkflowId: str(candidate.interviewSnapshotWorkflowId) || null,
    outcome,
    source: source || null,
    // RingCX system disposition label (e.g. CONGESTION) — reporting only, never routing.
    systemDisposition: str(systemDisposition) || null,
    badNumber: badNumber === true,
    badNumberReason: str(badNumberReason) || null,
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
    const {
      session = {},
      candidate = {},
      outcome = null,
      source = null,
      eventType = "terminal",
      systemDisposition = null,
      badNumber = false,
      badNumberReason = null,
    } = input;
    const at = (input.now instanceof Date ? input.now : (input.now ? new Date(input.now) : new Date())).toISOString();
    const idemKey = makeOutcomeIdemKey({
      sessionId: session.sessionId,
      queueItemId: candidateKey(candidate),
      uii: candidate.uii,
      caseId: candidate.caseId,
      eventType,
    });

    const cadenceEvent = {
      ...buildCadenceEvent({
        session,
        candidate,
        outcome,
        source,
        at,
        systemDisposition,
        badNumber,
        badNumberReason,
      }),
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
  buildTerminalEvidenceKeys,
  buildReviewCorrectionRow,
  buildCadenceEvent,
  createCxBulkLoadOutcomeAdapter,
};
