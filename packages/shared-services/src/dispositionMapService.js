"use strict";

// dispositionMapService — canonical mapping between OUR disposition
// labels (the SPA buttons agents click) and:
//   1. The RingCX disposition code we tag the call with for reporting
//   2. The cadence-engine reschedule rule (what to do with the lead next)
//   3. The QueueItem terminal state (completed vs recycled)
//
// Single source of truth so SPA, dial service, and cadence engine all
// agree on what each click means.

const DISPOSITION_MAP = Object.freeze({
  // ── Terminal outcomes (lead leaves the queue) ───────────────────
  callback: {
    label: "Callback",
    rcxCode: "Callback",
    rescheduleRule: "agreed",       // requires payload.callbackAt
    queueItemState: "completed",
    requiresPayload: ["callbackAt"],
    isTerminal: true,
  },
  postdate: {
    label: "Post-Date",
    rcxCode: "Postdate",
    rescheduleRule: "+30d",
    queueItemState: "completed",
    requiresPayload: [],
    isTerminal: true,
  },
  deal: {
    label: "Deal / Sale",
    rcxCode: "Sale",
    rescheduleRule: "stop",         // lead converted, no more touches
    queueItemState: "completed",
    requiresPayload: [],
    isTerminal: true,
  },
  dnc: {
    label: "Do Not Call",
    rcxCode: "DoNotCall",
    rescheduleRule: "stop",
    queueItemState: "completed",
    requiresPayload: [],
    isTerminal: true,
  },
  wrong_number: {
    label: "Wrong Number",
    rcxCode: "WrongNumber",
    rescheduleRule: "stop",
    queueItemState: "completed",
    requiresPayload: [],
    isTerminal: true,
  },

  // ── Recycling outcomes (lead stays in pool, bumped to bottom) ───
  did_not_connect: {
    label: "No Answer",
    rcxCode: "Auto Dispo",
    rescheduleRule: "+30m",
    queueItemState: "recycled",
    requiresPayload: [],
    isTerminal: false,
  },
  voicemail: {
    label: "Left Voicemail",
    rcxCode: "VM DROP",
    rescheduleRule: "+1d",
    queueItemState: "recycled",
    requiresPayload: [],
    isTerminal: false,
  },
});

function listDispositions() {
  return Object.entries(DISPOSITION_MAP).map(([key, value]) => ({
    key,
    ...value,
  }));
}

function getDisposition(key) {
  return DISPOSITION_MAP[key] || null;
}

// Validate a disposition payload against the map's requirements.
// Returns { ok: true } or { ok: false, errors: [...] }.
function validateDisposition(key, payload = {}) {
  const def = DISPOSITION_MAP[key];
  if (!def) return { ok: false, errors: [`unknown disposition: ${key}`] };
  const errors = [];
  for (const required of def.requiresPayload || []) {
    if (payload[required] === undefined || payload[required] === null || payload[required] === "") {
      errors.push(`missing required field: ${required}`);
    }
  }
  // Validate callbackAt is a parseable date
  if (def.requiresPayload?.includes("callbackAt") && payload.callbackAt) {
    const d = new Date(payload.callbackAt);
    if (Number.isNaN(d.getTime())) errors.push("callbackAt is not a valid date");
    if (d.getTime() < Date.now() - 60_000) errors.push("callbackAt must be in the future");
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// Compute the next-touch Date for cadence engine based on rescheduleRule.
// Returns null for "stop" (no future touch).
function computeNextTouchAt(rescheduleRule, payload = {}, now = new Date()) {
  if (!rescheduleRule || rescheduleRule === "stop") return null;
  if (rescheduleRule === "agreed") {
    return payload.callbackAt ? new Date(payload.callbackAt) : null;
  }
  // Pattern: +Nm | +Nh | +Nd | +Nw
  const match = String(rescheduleRule).match(/^\+(\d+)([mhdw])$/);
  if (!match) return null;
  const [, nStr, unit] = match;
  const n = Number(nStr);
  const unitMs = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  }[unit];
  return new Date(now.getTime() + n * unitMs);
}

module.exports = {
  DISPOSITION_MAP,
  listDispositions,
  getDisposition,
  validateDisposition,
  computeNextTouchAt,
};
