"use strict";

// CALL WRAP CARD SERVICE — the wrap layer's brain (design:
// docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md). Laws it implements:
//   PURITY:    the dialer's outcome writes zero case-land; the CARD is the only writer.
//   TRIGGER:   spoke-to-a-human only — OUR outcome enum "answered", terminal rows only
//              (corrections never card — no cycles).
//   CLOCK:     card lifetime = the 2-hour quarantine window.
//   PROTOCOL:  one resolveCard pipeline, RESOLUTION_RULES carries the per-action policy —
//              every resolution (incl. ✕/expiry) files the INTERVIEW when material exists.
//   LAYERING:  this service does EXTERIOR calls (via injected deps) + emits correction
//              ROWS; the drain remains the single Mongo app-state writer.
// All I/O injected — unit-tests with fakes, no Mongo.

const WRAP_CARD_TTL_MS = 2 * 60 * 60 * 1000; // the 2-hour quarantine clock

function cleanText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim() || null;
}

const RESOLUTION_RULES = {
  dnc: { logicsStatus: true, interview: true, correctionRow: "dnc" },
  appointment: { appointment: true, interview: true },
  dismissed: { interview: true, cadence: true },
  expired: { interview: true },
};

// The spoke-to-a-human trigger. `answered` can only be produced by an agent click or the
// connected-latch + real-pickup guard — RingCX's messy "answered" never reaches this enum.
function wrapCardNeeded(payload = {}) {
  const eventType = String(payload.eventType || "terminal").trim().toLowerCase();
  if (eventType !== "terminal") return false;
  const outcome = String(payload.outcome || "").trim().toLowerCase();
  const nextAction = String(payload.nextAction || "").trim().toLowerCase();
  return outcome === "answered" && nextAction === "call_wrap";
}

// Pure card constructor — the dossier frozen at hang-up.
function buildWrapCard({ row = {}, payload = {}, coachSummary = null } = {}) {
  const calledAt = payload.at || payload.outcomeAt || row.createdAt || new Date().toISOString();
  const calledAtDate = new Date(calledAt);
  const safeCalledAt = Number.isNaN(calledAtDate.getTime()) ? new Date() : calledAtDate;
  return {
    idemKey: row.idemKey || payload.idemKey || null,
    sessionId: payload.sessionId || row.sessionId || null,
    domain: payload.domain || row.domain || null,
    queueItemId: payload.queueItemId || row.queueItemId || null,
    uii: payload.uii || row.uii || null,
    caseId: Number(payload.caseId ?? row.caseId) || null,
    agentEmail: String(payload.agentEmail || row.agentEmail || "").trim().toLowerCase() || null,
    agentName: payload.agentName || row.agentName || null,
    name: cleanText(
      payload.name ||
        payload.prospectName ||
        payload.contactName ||
        payload.fullName ||
        row.name ||
        row.prospectName,
    ),
    outcome: payload.outcome || row.outcome || null,
    systemDisposition: payload.systemDisposition || null,
    calledAt: safeCalledAt,
    coachSessionId: payload.coachSessionId || row.coachSessionId || null,
    // STRING-ONLY: a status/report object in any summary slot must never shadow the
    // payload text fallback (2026-07-07 live find) — non-strings are treated as absent.
    coachSummary: [coachSummary, payload.callSummary, payload.summary]
      .map((v) => (typeof v === "string" && v.trim() ? v.trim() : null))
      .find(Boolean) || null,
    formSnapshot: payload.formSnapshot || null, // arrives with WO-17
    payload,
    expiresAt: new Date(safeCalledAt.getTime() + WRAP_CARD_TTL_MS),
  };
}

function hasInterviewMaterial(card = {}) {
  return Boolean(card.coachSummary || card.coachSessionId || card.formSnapshot);
}

function createCxCallWrapCardService({
  cardRepository,
  outboxRepository = null,       // findByIdentity + insertOnce (the correction-row lane)
  buildCorrectionRow = null,     // buildReviewCorrectionRow from the outcome adapter
  writeInterview = null,         // async (card) => {} — the Logics activity + case comm
  createAppointment = null,      // async ({card, appointmentAt, appointmentDate, appointmentTime, appointmentTimezone, user}) => {}
  updateLogicsDncStatus = null,  // async (card) => {} — optional until the Logics DNC lands
  releaseToCadence = null,
  logger = console,
} = {}) {
  if (!cardRepository || typeof cardRepository.insertOnce !== "function") {
    throw new Error("createCxCallWrapCardService requires cardRepository");
  }

  // DRAIN-SIDE: create the card for a qualifying drained row. Exactly-once via idemKey.
  async function createFromDrain({ row = {}, payload = {}, coachSummary = null } = {}) {
    if (!wrapCardNeeded(payload)) return { skipped: true, reason: "not-card-material" };
    const card = buildWrapCard({ row, payload, coachSummary });
    if (!card.idemKey) return { skipped: true, reason: "no-idem-key" };
    const created = await cardRepository.insertOnce(card);
    return created ? { ok: true, created: true, idemKey: card.idemKey } : { ok: true, created: false, duplicate: true };
  }

  async function listPending(agentEmail) {
    return cardRepository.listPendingForAgent(agentEmail);
  }

  async function getCard(idemKey) {
    return cardRepository.findByIdemKey(idemKey);
  }

  // THE UNIFIED RESOLUTION PROTOCOL. One pipeline; the rules row is the only difference.
  // CAS-first: a card resolves exactly once; every later attempt is a clean no-op.
  async function resolve({
    idemKey,
    action,
    appointmentAt = null,
    appointmentDate = null,
    appointmentTime = null,
    appointmentTimezone = null,
    user = null,
    resolvedBy = null,
  } = {}) {
    const resolution = String(action || "").trim().toLowerCase();
    const rules = RESOLUTION_RULES[resolution];
    if (!rules) return { ok: false, reason: "unknown-action" };
    const appointmentInput = {
      appointmentAt: appointmentAt || null,
      appointmentDate: appointmentDate || null,
      appointmentTime: appointmentTime || null,
      appointmentTimezone: appointmentTimezone || null,
    };
    const hasAppointmentDateTime = Boolean(appointmentInput.appointmentDate && appointmentInput.appointmentTime);
    const hasAppointmentTarget = Boolean(appointmentInput.appointmentAt || hasAppointmentDateTime);
    if (resolution === "appointment" && !hasAppointmentTarget) {
      return { ok: false, reason: "appointment-requires-datetime" };
    }
    const card = await cardRepository.resolveCard(idemKey, resolution, {
      resolvedBy,
      detail: hasAppointmentTarget ? appointmentInput : null,
    });
    if (!card) return { ok: true, noop: true, reason: "already-resolved-or-missing" };

    const effects = { interview: null, correction: null, appointment: null, logicsStatus: null, cadence: null };
    // Every effect runs through this guard: the card is ALREADY resolved (CAS-first), so
    // no effect failure — async rejection OR synchronous throw (2026-07-07 live find: a
    // missing import threw a ReferenceError past .catch and 500'd the route mid-protocol)
    // — may escape; it degrades to {ok:false} and the log tells the story.
    const runEffect = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        return { ok: false, error: err?.message || "effect-failed" };
      }
    };

    // Interview activity — every resolution files it when there's material (fail-soft:
    // the card is already resolved; a Logics blip must not un-resolve it).
    if (rules.interview && writeInterview && hasInterviewMaterial(card)) {
      effects.interview = await runEffect(() => writeInterview(card));
    }

    // DNC app-side: a correction ROW into the outbox — the drain applies it (layering law).
    if (rules.correctionRow === "dnc" && outboxRepository && buildCorrectionRow) {
      try {
        const original = await outboxRepository.findByIdentity({
          sessionId: card.sessionId,
          queueItemId: card.queueItemId,
          uii: card.uii,
        });
        const correction = buildCorrectionRow({
          sessionId: card.sessionId,
          queueItemId: card.queueItemId,
          uii: card.uii,
          original,
          domain: card.domain,
          agentEmail: resolvedBy || card.agentEmail,
          caseId: card.caseId,
        });
        const inserted = await outboxRepository.insertOnce(correction);
        effects.correction = { ok: true, inserted: Boolean(inserted) };
      } catch (err) {
        effects.correction = { ok: false, error: err?.message };
      }
      if (rules.logicsStatus && updateLogicsDncStatus) {
        effects.logicsStatus = await runEffect(() => updateLogicsDncStatus(card));
      }
    }

    if (rules.appointment && createAppointment) {
      effects.appointment = await runEffect(() => createAppointment({ card, ...appointmentInput, user }));
    }

    if (rules.cadence && releaseToCadence) {
      effects.cadence = await runEffect(() => releaseToCadence(card));
    }

    logger.info?.("cx.wrap_card.resolved", {
      idemKey: card.idemKey,
      resolution,
      caseId: card.caseId,
      queueItemId: card.queueItemId,
      agentEmail: card.agentEmail,
      resolvedBy: resolvedBy || null,
      interviewOk: effects.interview ? effects.interview.ok !== false : null,
      correctionOk: effects.correction ? effects.correction.ok !== false : null,
      appointmentOk: effects.appointment ? effects.appointment.ok !== false : null,
      // the compliance-critical effect must never be the silent one (2026-07-07 find)
      logicsStatusOk: effects.logicsStatus ? effects.logicsStatus.ok !== false : null,
      cadenceOk: effects.cadence ? effects.cadence.ok !== false : null,
    });
    return { ok: true, resolution, card, effects };
  }

  // The janitor (runs from the drain tick per the auto-opt-out ruling): expire due cards
  // through the SAME pipeline — passive expiry is a first-class resolution.
  async function expireDue(now = new Date()) {
    const due = await cardRepository.listDueForExpiry(now).catch(() => []);
    let expired = 0;
    for (const card of due) {
      const result = await resolve({ idemKey: card.idemKey, action: "expired", resolvedBy: "wrap-janitor" })
        .catch(() => null);
      if (result && result.ok && !result.noop) expired += 1;
    }
    return { due: due.length, expired };
  }

  return { createFromDrain, getCard, listPending, resolve, expireDue };
}

module.exports = {
  RESOLUTION_RULES,
  WRAP_CARD_TTL_MS,
  buildWrapCard,
  createCxCallWrapCardService,
  wrapCardNeeded,
};
