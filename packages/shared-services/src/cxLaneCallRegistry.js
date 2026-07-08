"use strict";

// LANE CALL REGISTRY (Mickey's modal ruling, 2026-07-08): "it should only fire the UI
// when there's a uii for the call — use the poller to check all three sources for the
// extern id to determine the type, then that triggers the modal."
//
// The watcher (the poller) recognizes lane calls each tick and refreshes this in-memory
// map; the /lane-call route reads it; the client polls the route and shows the modal.
// TTL-swept: a call that stops appearing in the poller's snapshot stops refreshing and
// the entry dies within LANE_CALL_TTL_MS — the modal auto-dismisses. In-memory on
// purpose (a restart just goes blank for one tick); the poller rebuilds it every ~1s.

const LANE_CALL_TTL_MS = 8_000;
const registry = new Map(); // agentEmail -> { lane, uii, externId, caseId, name, meta, refreshedAt }

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function setLaneCall(agentEmail, laneCall, { nowMs = Date.now() } = {}) {
  const key = normalizeEmail(agentEmail);
  if (!key || !laneCall || !laneCall.uii) return false; // THE UII GATE — no uii, no modal
  registry.set(key, { ...laneCall, refreshedAt: nowMs });
  return true;
}

function getLaneCall(agentEmail, { nowMs = Date.now() } = {}) {
  const key = normalizeEmail(agentEmail);
  const entry = registry.get(key);
  if (!entry) return null;
  if (nowMs - entry.refreshedAt > LANE_CALL_TTL_MS) {
    registry.delete(key);
    return null;
  }
  return entry;
}

function clearLaneCall(agentEmail) {
  registry.delete(normalizeEmail(agentEmail));
}

module.exports = {
  LANE_CALL_TTL_MS,
  setLaneCall,
  getLaneCall,
  clearLaneCall,
};
