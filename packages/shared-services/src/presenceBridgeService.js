"use strict";

// EX → CX presence reactor.
//
// Subscribes to RC EX presence events (via the existing
// processPresenceEnvelope flow that fires PRESENCE_OBSERVED events),
// runs the snapshot through agentAvailabilityService.deriveCxRouting,
// and applies the resulting desiredAvailability to RingCX.
//
// EX-wins rule (from the user): CX is active by default, only goes
// inactive when EX is active. Symmetric in both directions:
//   EX off-hook → CX leads suppressed (no new dials get fed to agent)
//   EX on-hook  → CX leads ready (auto-resume, no manual toggle)
//
// Why we don't push state to RingCX directly:
// RingCX has no public state-change endpoint that doesn't disrupt
// the dashboard session. /agents/{id}/logout works but kills the
// session. SUPPRESS_LEADS / CANCEL_LEADS endpoints return 500 on
// this tenant for every body shape we tried. So we DON'T touch
// RingCX-side state at all.
//
// Instead the bridge persists desiredAvailability to Mongo (via
// Codex's mirrorAgentState) and the lead PUSHER (ringcxLeadServingService)
// gates on it before pushing. EX-wins rule per the user:
//   - in-flight CX calls keep going (manual hangup OK if EX rings)
//   - no NEW leads get pushed while EX is busy
//   - already-queued leads in RingCX may attempt to dial; agent ignores;
//     they get a no-answer disposition (acceptable per stakeholder)
//
// When RingCX exposes a public state-change endpoint or we
// reverse-engineer the dashboard's WebRTC signaling, we can add a
// belt-and-suspenders push back to RingCX. Until then the Mongo gate
// is sufficient.

const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");
const {
  agentStateRepository,
} = require("../../shared-repositories/src");
const {
  deriveCxRouting,
  mirrorAgentState,
} = require("./agentAvailabilityService");

// In-process action cache so the reactor doesn't re-fire on every
// presence tick — only when the desiredAvailability actually changes.
const lastAppliedByExtension = new Map();

function normalizeExtensionId(value) {
  if (value == null) return null;
  return String(value).trim();
}

// ── Resolve an agent's CX wiring from the snapshot ─────────────────
//
// Each EX extension maps to one CX agent (which lives in one agent
// group, attached to one or more dial groups). The mapping today is
// captured on the agent record at creation time (cxAgentId on the
// snapshot, plus rcUserId on the agent record). Later we can
// formalize this as a UserAccount → cxAgent join.
async function resolveCxWiringForExtension(extensionId, snapshot = {}) {
  // Snapshot may already carry the cxAgentId if mirrorAgentState
  // populated it. Fall back to looking up the existing record.
  if (snapshot.cxAgentId && snapshot.cxAgentGroupId && snapshot.cxDialGroupIds) {
    return {
      cxAgentId: Number(snapshot.cxAgentId),
      cxAgentGroupId: Number(snapshot.cxAgentGroupId),
      cxDialGroupIds: (snapshot.cxDialGroupIds || []).map(Number),
    };
  }
  const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId);
  return {
    cxAgentId: existing?.cxAgentId ? Number(existing.cxAgentId) : null,
    cxAgentGroupId: existing?.cxAgentGroupId ? Number(existing.cxAgentGroupId) : null,
    cxDialGroupIds: Array.isArray(existing?.cxDialGroupIds)
      ? existing.cxDialGroupIds.map(Number).filter(Boolean)
      : [],
  };
}

// Apply layer is intentionally a no-op for now. The gating that
// actually prevents dials while EX is busy lives in
// `ringcxLeadServingService.publishQueueItemToRingcx` — it reads
// the agent's cxRouting from Mongo before pushing a new lead. Since
// RingCX has no working public endpoint to suppress leads on this
// tenant, we don't try.
async function applyLeadSuppression(_client, dialGroupId, desired) {
  return {
    applied: "noop",
    dialGroupId,
    desired,
    reason: "RingCX has no working state-change endpoint; gating happens at the lead-pusher",
  };
}

// ── Public entry: react to a single presence change ────────────────
//
// Call this from anywhere a presence event lands — the existing
// processPresenceEnvelope flow, the polling bridge, or a webhook
// handler. Idempotent: if desiredAvailability hasn't changed since
// the last call for this extension, returns early without hitting
// RingCX.
async function reactToPresenceChange(snapshot = {}, options = {}) {
  const extensionId = normalizeExtensionId(snapshot.extensionId);
  if (!extensionId) {
    return { skipped: true, reason: "no-extension-id" };
  }

  // 1. Persist the snapshot + recompute cxRouting via Codex's policy.
  //    This gives us the canonical desiredAvailability + records the
  //    decision on the AgentState document for audit / SPA reads.
  const persisted = await mirrorAgentState(snapshot);
  const desired = persisted?.cxRouting?.desiredAvailability || "available";
  const reason = persisted?.cxRouting?.reason || "unknown";

  // 2. Skip if nothing changed since the last reaction (idempotency).
  const last = lastAppliedByExtension.get(extensionId);
  if (last === desired && !options.forceApply) {
    return { skipped: true, reason: "no-change", desired, ext: extensionId };
  }

  // 3. Resolve CX wiring (which dial group(s) to suppress in).
  const wiring = await resolveCxWiringForExtension(extensionId, snapshot);
  if (!wiring.cxDialGroupIds.length) {
    lastAppliedByExtension.set(extensionId, desired);
    return {
      skipped: true,
      reason: "no-cx-dial-groups-mapped",
      desired,
      ext: extensionId,
      mapping: wiring,
    };
  }

  // 4. Apply to each dial group.
  const client = createRingcxVoiceClient(options.client || {});
  const applied = [];
  for (const dialGroupId of wiring.cxDialGroupIds) {
    const r = await applyLeadSuppression(client, dialGroupId, desired);
    applied.push(r);
  }

  lastAppliedByExtension.set(extensionId, desired);
  return {
    applied,
    desired,
    reason,
    ext: extensionId,
    cxAgentId: wiring.cxAgentId,
  };
}

// ── Public: clear the in-process cache ─────────────────────────────
//
// Useful for tests and for forcing a re-apply on the next presence
// event (e.g., after an admin manually changed lead state out-of-band).
function clearAppliedCache(extensionId = null) {
  if (extensionId) {
    lastAppliedByExtension.delete(normalizeExtensionId(extensionId));
  } else {
    lastAppliedByExtension.clear();
  }
}

// ── Snapshot helpers shared with the polling bridge script ─────────
//
// Convert a raw RC presence response into the snapshot shape
// agentAvailabilityService expects. Exported so scripts and the
// EX webhook handler can both build snapshots consistently.
function buildSnapshotFromRcPresence(rcPresence, { extensionId, cxAgentId, cxAgentGroupId, cxDialGroupIds } = {}) {
  const activeCall = Array.isArray(rcPresence?.activeCalls) ? rcPresence.activeCalls[0] : null;
  return {
    extensionId,
    cxAgentId: cxAgentId || null,
    cxAgentGroupId: cxAgentGroupId || null,
    cxDialGroupIds: Array.isArray(cxDialGroupIds) ? cxDialGroupIds : [],
    name: rcPresence?.contact?.firstName
      ? `${rcPresence.contact.firstName} ${rcPresence.contact.lastName || ""}`.trim()
      : null,
    company: "TAG",
    status:
      rcPresence?.telephonyStatus === "Ringing" ? "ringing"
      : rcPresence?.telephonyStatus === "CallConnected" ? "onCall"
      : rcPresence?.userStatus === "Available" ? "available"
      : "offline",
    exTelephonyStatus: rcPresence?.telephonyStatus || "NoCall",
    exPresenceStatus: rcPresence?.presenceStatus || "Offline",
    currentCall: activeCall ? {
      sessionId: activeCall.sessionId,
      telephonySessionId: activeCall.telephonySessionId,
      from: activeCall.from,
      to: activeCall.to,
      direction: activeCall.direction,
      channel: "ex",
    } : {},
    activePlatform: rcPresence?.telephonyStatus && rcPresence.telephonyStatus !== "NoCall" ? "EX" : "none",
    upstream: { source: "presence-bridge", mirroredAt: new Date() },
  };
}

module.exports = {
  reactToPresenceChange,
  buildSnapshotFromRcPresence,
  applyLeadSuppression,
  resolveCxWiringForExtension,
  clearAppliedCache,
  // Re-export for convenience so callers don't need to import both
  // services to compute + react.
  deriveCxRouting,
  mirrorAgentState,
};
