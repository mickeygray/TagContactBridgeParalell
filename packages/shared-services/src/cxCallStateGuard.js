"use strict";

// Shared guard for clearing a CX agent's active call.
//
// WHY: four functions (markAgentAvailableAfterAutoDisposition in ringcxDialExecutionService
// and dialService, clearAgentCxCallState in cxWorkspaceService, clearAgentCxCallStateForTerminalOutcome
// in cxCadenceService) each had the SAME guard shape:
//
//   if (requestedIdentity && existingIdentity && existingIdentity !== requestedIdentity && activePlatform==="CX")
//     return skip "different-active-cx-call";
//   // ...else clear currentCall:{}
//
// It blocks clearing a DIFFERENT live call, but NOT clearing an active CX call when the
// request carries NO identity (requestedIdentity is null because the UII was missing). That
// hole let an auto-disposition with uii:null wipe a live CX call (incident 2026-06-15:
// Chris Bolt's screen advanced Tracey Giles -> Veronica Chavez with no submission). Because
// `currentCall` was wiped, the EX presence reconciler's own CX-hold guard (shouldHoldCxDisposition)
// then had nothing to hold and repeatedly re-cleared the agent to available, and the queue
// served the next lead. Preserving currentCall on a missing-UII clear re-arms that downstream
// guard, so this single fix breaks the whole chain. See docs/cx-handoff-tracey-veronica.PLAN.md.
//
// This module is PURE POLICY so it unit-tests without Mongo/RingCX. Callers resolve their own
// requestedIdentity (each has a different fallback chain) and pass the agentState record.

function callIdentity(call = {}) {
  const value =
    call?.telephonySessionId || call?.sessionId || call?.callSessionId || call?.uii || "";
  return String(value || "").trim() || null;
}

// Anti-stranding safety valve. If a CX call with NO matching identity has been active longer
// than this, allow the clear (it has almost certainly ended and no UII-tagged release arrived).
// Default: disabled (null) — a missing-UII clear is always skipped, and the call is released by
// a UII-matched disposition or by the agent finishing it on-screen (which is the desired
// behavior; the call stays the agent's active lead until properly resolved). Operators can set
// CX_MISSING_UII_MAX_HOLD_MS to bound the worst case for the rare "ended with no UII ever
// captured" path. The proper long-term release is corroborated NoCall (see plan P0d).
function getCxMissingUiiMaxHoldMs() {
  const raw = Number(process.env.CX_MISSING_UII_MAX_HOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

// Pure decision. Returns a skip-reason string when the clear must be BLOCKED, else null.
//   existingIdentity   identity of the agent's current call (or null)
//   requestedIdentity  identity carried by the clear request (or null)
//   activePlatformIsCx agentState.activePlatform === "CX"  (preserves the exact legacy condition)
//   channelIsCx        currentCall.channel === "cx"        (broadens ONLY the new missing-UII skip)
//   callStartedAtMs/nowMs/maxHoldMs  optional anti-stranding valve inputs
function cxClearSkipReason({
  existingIdentity = null,
  requestedIdentity = null,
  activePlatformIsCx = false,
  channelIsCx = false,
  callStartedAtMs = null,
  nowMs = null,
  maxHoldMs = null,
} = {}) {
  // Nothing to protect if we hold no identity for the current call.
  if (!existingIdentity) return null;

  if (requestedIdentity) {
    // Legacy behavior, preserved exactly: a DIFFERENT live CX call is never cleared by a
    // request for another call. (Only fires when activePlatform === "CX", as before.)
    if (activePlatformIsCx && existingIdentity !== requestedIdentity) {
      return "different-active-cx-call";
    }
    return null;
  }

  // NEW: the request carries no identity while a CX call is active (by platform OR channel).
  if (!activePlatformIsCx && !channelIsCx) return null;

  // Anti-stranding valve: allow the clear if the call is provably older than maxHoldMs.
  if (
    Number.isFinite(maxHoldMs) && maxHoldMs > 0 &&
    Number.isFinite(callStartedAtMs) && Number.isFinite(nowMs) &&
    nowMs - callStartedAtMs > maxHoldMs
  ) {
    return null;
  }

  return "missing-uii-active-cx-call";
}

// Convenience: derive the policy inputs from an agentState `existing` record + a raw requested
// identity, and return { skip, existingIdentity, requestedIdentity } for the caller's payload.
function evaluateCxClear(existing, requestedIdentityRaw, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxHoldMs = options.maxHoldMs === undefined ? getCxMissingUiiMaxHoldMs() : options.maxHoldMs;
  const currentCall =
    existing?.currentCall && typeof existing.currentCall === "object" ? existing.currentCall : {};
  const existingIdentity = callIdentity(currentCall);
  const requestedIdentity = String(requestedIdentityRaw || "").trim() || null;
  const activePlatformIsCx = String(existing?.activePlatform || "").trim().toUpperCase() === "CX";
  const channelIsCx = String(currentCall.channel || "").trim().toLowerCase() === "cx";
  const startedRaw = currentCall.startTime || currentCall.startedAt || currentCall.answeredAt || null;
  const parsed = startedRaw ? Date.parse(startedRaw) : NaN;
  const callStartedAtMs = Number.isFinite(parsed) ? parsed : null;

  const skip = cxClearSkipReason({
    existingIdentity,
    requestedIdentity,
    activePlatformIsCx,
    channelIsCx,
    callStartedAtMs,
    nowMs,
    maxHoldMs,
  });
  return { skip, existingIdentity, requestedIdentity };
}

// EX->CX decoupling (phase-out, 2026-06-15). Decide whether the EX presence poll must PRESERVE
// the agent's CX call-state instead of overwriting it from the EX dial-in log. CX call-state is
// owned by the RingCX/UII path; EX presence is stale and must not determine it. Pure + env-free
// for testing — the caller (ringcentralExService.reconcilePolledPresence) supplies the rollout
// flag `enabled` and the already-extracted primitives:
//   previousHasCxCall : the agent currently holds a CX call snapshot (channel cx / activePlatform CX + identity)
//   previousCxIdentity: that held call's UII/session identity
//   exActiveIdentity  : identity of the EX active call the poll currently sees (or null)
//   exActiveIsBridge  : that EX active call is the suppressed CX dial-in bridge leg
// Returns { cxOwnsCallState, forceExNoCall }.
//   cxOwnsCallState=true  -> the poll must keep currentCall/activePlatform/status as the held CX call
//   forceExNoCall=true    -> set exTelephonyStatus="NoCall" so the EX-busy lead gate is unchanged
//                            (the bridge dial-in never counted as EX-busy)
// When `enabled` is false this ALWAYS returns the no-op result, so the poll behaves exactly as today.
function decideExPollCxOwnership({
  enabled = false,
  mode = null,
  previousHasCxCall = false,
  previousCxIdentity = null,
  exActiveIdentity = null,
  exActiveIsBridge = false,
} = {}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const cxOwnedMode = normalizedMode === "cx-owned";
  if (!enabled) return { cxOwnsCallState: false, forceExNoCall: false };
  if (!previousHasCxCall || !previousCxIdentity) return { cxOwnsCallState: false, forceExNoCall: false };
  if (cxOwnedMode) return { cxOwnsCallState: true, forceExNoCall: true };
  // A genuine, DIFFERENT, non-bridge EX call means the agent really IS on an EX call -> defer to EX.
  if (exActiveIdentity && exActiveIdentity !== previousCxIdentity && !exActiveIsBridge) {
    return { cxOwnsCallState: false, forceExNoCall: false };
  }
  return { cxOwnsCallState: true, forceExNoCall: Boolean(exActiveIsBridge) };
}

module.exports = {
  callIdentity,
  cxClearSkipReason,
  evaluateCxClear,
  getCxMissingUiiMaxHoldMs,
  decideExPollCxOwnership,
};
