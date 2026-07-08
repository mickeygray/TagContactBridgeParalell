"use strict";

// THE LANE REGISTRY (Mickey's ruling, 2026-07-07: "every agent serves each type of lead
// from a discrete place"). Three lanes, one shape: a mark takes the lead out of general
// circulation -> a discrete per-agent RingCX place -> a dispatch trigger -> drain-side
// exactly-once consumption releases the mark. The differences are configuration:
//
//   bulk         cxbl-*   family reservation            agent fetch/dial
//   first touch  cxft-*   metadata.firstTouchPending    mint drip (this file's map)
//   appointment  cxapt-*  metadata.appointmentId hold   the clock: appointmentAt
//
// Everything here is PURE and pinned. Design: docs/CX_APPOINTMENT_LANE_DESIGN_2026-07-07.md,
// docs/CX_FIRST_TOUCH_IMPLEMENTATION_PLAN_2026-07-07.md.

const LANES = Object.freeze({
  bulk: "cxbl",
  firstTouch: "cxft",
  appointment: "cxapt",
});

function str(value) {
  return String(value == null ? "" : value).trim();
}

// cxft-<domain>-<queueItemId> / cxapt-<appointmentId>. Bulk keeps its own richer builder
// (cxBulkLoadLeadSourceService.buildExternId — session-token aware); the registry only
// needs to RECOGNIZE its prefix.
function buildLaneExternId(lane, parts = {}) {
  const prefix = LANES[lane];
  if (!prefix) throw new Error(`unknown lane: ${lane}`);
  if (lane === "appointment") {
    const id = str(parts.appointmentId || parts.id);
    if (!id) throw new Error("appointment extern needs appointmentId");
    return `${prefix}-${id}`;
  }
  const domain = str(parts.domain).toLowerCase();
  const id = str(parts.queueItemId || parts.id);
  if (!domain || !id) throw new Error(`${lane} extern needs domain + queueItemId`);
  return `${prefix}-${domain}-${id}`;
}

function parseLaneFromExternId(externId) {
  const parsed = parseLaneExternId(externId);
  return parsed ? parsed.lane : null;
}

function parseLaneExternId(externId) {
  const raw = str(externId);
  const value = raw.toLowerCase();
  if (!value) return null;
  if (value.startsWith(`${LANES.appointment}-`)) {
    const appointmentId = raw.slice(LANES.appointment.length + 1).trim();
    return appointmentId ? { lane: "appointment", appointmentId } : null;
  }
  if (value.startsWith(`${LANES.firstTouch}-`)) {
    const rest = raw.slice(LANES.firstTouch.length + 1).trim();
    const firstDash = rest.indexOf("-");
    if (firstDash <= 0) return null;
    const domain = rest.slice(0, firstDash).trim();
    const queueItemId = rest.slice(firstDash + 1).trim();
    return domain && queueItemId ? { lane: "firstTouch", domain, queueItemId } : null;
  }
  if (value === LANES.bulk || value.startsWith(`${LANES.bulk}-`)) {
    return { lane: "bulk" };
  }
  return null;
}

// The per-agent queue map rides one env var per lane as JSON:
//   {"brad@x.com": 12345} or {"brad@x.com": {"campaignId": 12345}}
// -> [{ agentEmail, campaignId }], invalid entries dropped (never a throw — a bad map
// entry must not take the dispatcher down; the dispatcher traces what it skipped).
function parseAgentQueueMap(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const entries = [];
  for (const [email, value] of Object.entries(parsed)) {
    const agentEmail = str(email).toLowerCase();
    const campaignId = str(
      value && typeof value === "object" ? value.campaignId : value,
    );
    if (agentEmail && campaignId) entries.push({ agentEmail, campaignId });
  }
  return entries.sort((a, b) => a.agentEmail.localeCompare(b.agentEmail));
}

module.exports = {
  LANES,
  buildLaneExternId,
  parseLaneExternId,
  parseLaneFromExternId,
  parseAgentQueueMap,
};
