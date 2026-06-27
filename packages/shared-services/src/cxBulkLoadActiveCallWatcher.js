"use strict";

// Active-call watcher for the bulk_load rail.
//
// Two pure functions (matchActiveCallToCandidates, deriveCurrentTransition) decide
// WHICH buffered candidate the live RingCX call is and what the current should do.
// One thin I/O function (loadActiveCallsSnapshot) reads RingCX. The pure pair tests
// with plain objects, zero mocks. The orchestrator turns a transition into a
// `current.matched` event for the state machine. See the plan: "### 6. Active Call
// Watcher" and the Clean Code Principles section (the watcher-tick example).
//
// Matching is externId-first and NEVER promotes on phone alone — that ambient
// phone-inference is the 2026-06-17 footgun. Phone is diagnostic only.

const MATCH_ORDER = Object.freeze(["externId", "queueItemId"]);

function str(value) {
  return String(value == null ? "" : value).trim();
}

// Identity stamped on the candidate at publish time.
function candidateExternId(candidate) {
  if (!candidate) return "";
  return str(candidate.externId || (candidate.ringcx && candidate.ringcx.externId));
}

function candidateQueueItemId(candidate) {
  if (!candidate) return "";
  return str(candidate.queueItemId || candidate.id || candidate._id);
}

// Normalize one raw RingCX active-call record to the few fields we match/show on.
function normalizeActiveCall(raw = {}) {
  return {
    externId: str(raw.externalId || raw.externId || raw.outboundExternid),
    uii: str(raw.uii) || null,
    callState: raw.callState || raw.state || null,
    dnis: str(raw.dnis || raw.dnisE164) || null,
    ani: str(raw.ani || raw.aniE164) || null,
    agentId: str(raw.agentId || raw.username) || null,
  };
}

function extractActiveCallList(response) {
  if (Array.isArray(response)) return response.map(normalizeActiveCall);
  if (!response || typeof response !== "object") {
    const error = new Error("active-call-list-empty-response");
    error.retryable = true;
    throw error;
  }

  const list =
    response.activeCalls ||
    response.results ||
    response.items ||
    response.records ||
    response.data;
  if (!Array.isArray(list)) {
    const error = new Error("active-call-list-unexpected-response");
    error.retryable = true;
    error.keys = Object.keys(response).slice(0, 12);
    throw error;
  }
  return list.map(normalizeActiveCall);
}

// PURE. Decide which buffered candidate (if any) the live call is.
// Returns one of:
//   { status: "empty" }                                  — no relevant live calls
//   { status: "matched", candidate, activeCall, matchReasons }
//   { status: "ambiguous", reason }                      — live calls exist, no confident match
function matchActiveCallToCandidates(activeCalls = [], candidates = []) {
  const calls = Array.isArray(activeCalls) ? activeCalls.map(normalizeActiveCall) : [];
  if (!calls.length) return { status: "empty" };

  const byExternId = new Map();
  const byQueueItemId = new Map();
  for (const c of candidates || []) {
    const ext = candidateExternId(c);
    const qid = candidateQueueItemId(c);
    if (ext) byExternId.set(ext, c);
    if (qid) byQueueItemId.set(qid, c);
  }

  const matches = [];
  for (const call of calls) {
    if (call.externId && byExternId.has(call.externId)) {
      matches.push({ candidate: byExternId.get(call.externId), activeCall: call, matchReasons: ["externId"] });
      continue;
    }
    if (call.externId && byQueueItemId.has(call.externId)) {
      matches.push({ candidate: byQueueItemId.get(call.externId), activeCall: call, matchReasons: ["queueItemId"] });
    }
    // No phone-only fallback: an unmatched live call is never promoted to current.
  }

  if (!matches.length) return { status: "ambiguous", reason: "live-calls-no-identity-match" };

  const distinct = new Set(matches.map((m) => candidateQueueItemId(m.candidate)));
  if (distinct.size > 1) return { status: "ambiguous", reason: "multiple-candidate-matches" };

  return { status: "matched", ...matches[0] };
}

// PURE. Given the present current and a match result, decide the one transition.
//   { kind: "none" }                                  — leave current untouched
//   { kind: "same", candidate, uii, matchReasons }    — refresh evidence on current
//   { kind: "switch", candidate, uii, matchReasons, completePrevious, previousOutcome }
// A switch away from an active current carries completePrevious + the real departing
// outcome — auto-advance never invents a disposition.
function deriveCurrentTransition(current, matchResult) {
  if (!matchResult || matchResult.status !== "matched") return { kind: "none" };

  const candidate = matchResult.candidate;
  const uii = matchResult.activeCall ? matchResult.activeCall.uii : null;
  const matchReasons = matchResult.matchReasons || [];
  const matchedKey = candidateQueueItemId(candidate);
  const currentKey = current ? candidateQueueItemId(current) : "";

  if (!currentKey) {
    return { kind: "switch", candidate, uii, matchReasons, completePrevious: false };
  }
  if (currentKey === matchedKey) {
    return { kind: "same", candidate, uii, matchReasons };
  }
  return {
    kind: "switch",
    candidate,
    uii,
    matchReasons,
    completePrevious: true,
    // M11 gate 9: a RingCX auto-advance with no agent button intent is a released call that
    // did not connect — bucket it as the cadence outcome `did_not_connect`. The synthetic
    // `cx-auto-advanced` survives only as a separate debug reason, never as the outcome.
    previousOutcome: "did_not_connect",
    previousReason: "cx-auto-advanced",
  };
}

// PURE (M11 gate 1). Calls that RingCX dialed AND released entirely between two ~1s polls
// never surface as a current-to-next `switch` — they were active last tick, gone this tick,
// and were never promoted. Diff the prior poll's active externIds against now's: any pool
// candidate whose externId WAS active and is no longer is a released lead we must still count.
// Returns the released candidates plus the externId set to carry into the next poll's diff.
function deriveReleasedCandidates({ prevActiveExternIds = [], prevActiveCalls = [], activeCalls = [], pool = [] } = {}) {
  const calls = Array.isArray(activeCalls) ? activeCalls.map(normalizeActiveCall) : [];
  const nowActive = new Set(calls.map((c) => c.externId).filter(Boolean));
  const prevByExternId = new Map();
  for (const raw of Array.isArray(prevActiveCalls) ? prevActiveCalls : []) {
    const call = normalizeActiveCall(raw);
    if (call.externId) prevByExternId.set(call.externId, call);
  }
  for (const ext of Array.isArray(prevActiveExternIds) ? prevActiveExternIds : []) {
    const key = str(ext);
    if (key && !prevByExternId.has(key)) prevByExternId.set(key, { externId: key, uii: null });
  }
  const released = (Array.isArray(pool) ? pool : []).filter((cand) => {
    const ext = candidateExternId(cand);
    const previous = ext ? prevByExternId.get(ext) : null;
    return ext && previous && previous.uii && !nowActive.has(ext);
  }).map((cand) => {
    const previous = prevByExternId.get(candidateExternId(cand));
    return {
      ...cand,
      uii: cand.uii || previous.uii || null,
      activeCallSummary: previous || null,
    };
  });
  return { released, nextActiveExternIds: Array.from(nowActive), nextActiveCalls: calls };
}

// PURE. A current call is different from a buffered release: it is already on the
// middle panel. If RingCX showed its externId+UII last tick and no longer shows
// that externId now, clear current through a current-specific reducer event.
function deriveCurrentRelease({ current = null, prevActiveCalls = [], activeCalls = [] } = {}) {
  if (!current) return null;
  const ext = candidateExternId(current);
  if (!ext) return null;
  const calls = Array.isArray(activeCalls) ? activeCalls.map(normalizeActiveCall) : [];
  const nowActive = new Set(calls.map((c) => c.externId).filter(Boolean));
  if (nowActive.has(ext)) return null;

  const previous = (Array.isArray(prevActiveCalls) ? prevActiveCalls : [])
    .map(normalizeActiveCall)
    .find((call) => call.externId === ext && call.uii);
  if (!previous) return null;

  return {
    ...current,
    uii: current.uii || previous.uii || null,
    activeCallSummary: previous,
  };
}

// Thin I/O. Read this session's account-scoped active calls and normalize them.
// Caching (account-level, brief) is the orchestrator's concern, not this read's.
async function loadActiveCallsSnapshot(client, options = {}) {
  if (!client || typeof client.listActiveCalls !== "function") {
    throw new Error("loadActiveCallsSnapshot requires a RingCX client with listActiveCalls");
  }
  const response = await client.listActiveCalls({
    product: options.product || "ACCOUNT",
    productId: options.productId || options.accountId,
    externalId: options.externalId,
  });
  return extractActiveCallList(response);
}

module.exports = {
  MATCH_ORDER,
  normalizeActiveCall,
  matchActiveCallToCandidates,
  deriveCurrentTransition,
  deriveReleasedCandidates,
  deriveCurrentRelease,
  loadActiveCallsSnapshot,
};
