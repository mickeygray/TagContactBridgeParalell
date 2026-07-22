"use strict";

// Pins for the CALL WRAP CARD service (docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md):
// the spoke-to-a-human trigger, the 2h clock, and the unified resolution protocol —
// every resolution files the interview; only DNC emits a correction row; only
// appointment books; ✕/expiry write nothing else. All I/O faked.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  RESOLUTION_RULES,
  WRAP_CARD_TTL_MS,
  buildWrapCard,
  createCxCallWrapCardService,
  wrapCardNeeded,
} = require("../../packages/shared-services/src/cxCallWrapCardService");

test("TRIGGER: only OUR answered on terminal rows makes a card — corrections and non-contacts never do", () => {
  assert.equal(wrapCardNeeded({ outcome: "answered" }), false, "facts without a click destination never make work");
  assert.equal(wrapCardNeeded({ outcome: "answered", eventType: "terminal", nextAction: "call_wrap" }), true);
  assert.equal(wrapCardNeeded({ outcome: "answered", eventType: "review-dnc" }), false, "corrections never card — no cycles");
  assert.equal(wrapCardNeeded({ outcome: "voicemail" }), false);
  assert.equal(wrapCardNeeded({ outcome: "did_not_connect" }), false);
  assert.equal(wrapCardNeeded({ outcome: "dnc" }), false, "dnc left the disposition row — it lives on the card now");
  assert.equal(wrapCardNeeded({}), false);
});

test("THE 2H CLOCK: the card expires exactly two hours after the call", () => {
  const card = buildWrapCard({
    row: { idemKey: "q1:u1" },
    payload: { queueItemId: "q1", uii: "u1", outcome: "answered", nextAction: "call_wrap", at: "2026-07-06T20:00:00.000Z", caseId: 7, agentEmail: "A@X.com", name: "Lead" },
    coachSummary: "spoke about 941 debt",
  });
  assert.equal(card.idemKey, "q1:u1");
  assert.equal(card.agentEmail, "a@x.com", "agent email normalized");
  assert.equal(card.name, "Lead");
  assert.equal(card.expiresAt.getTime() - card.calledAt.getTime(), WRAP_CARD_TTL_MS);
  assert.equal(card.coachSummary, "spoke about 941 debt");
});

test("DOSSIER: wrap cards keep display names from terminal payload aliases", () => {
  const card = buildWrapCard({
    row: { idemKey: "q2:u2" },
    payload: {
      queueItemId: "q2",
      uii: "u2",
      outcome: "answered",
      nextAction: "call_wrap",
      prospectName: "Alias Prospect",
      at: "2026-07-06T20:00:00.000Z",
      caseId: 8,
      agentEmail: "a@x.com",
    },
  });
  assert.equal(card.name, "Alias Prospect");
});

function makeHarness({ resolveResult } = {}) {
  const calls = { interview: [], correction: [], appointment: [], cadence: [], dnc: [], resolutions: [] };
  const cardRepository = {
    async insertOnce(card) { calls.inserted = card; return card; },
    async findByIdemKey() { return null; },
    async listPendingForAgent() { return []; },
    async resolveCard(idemKey, resolution, detail) {
      calls.resolutions.push({ idemKey, resolution, detail });
      if (resolveResult === null) return null;
      return {
        idemKey, status: resolution,
        sessionId: "s1", queueItemId: "q1", uii: "u1", caseId: 7, domain: "WYNN",
        agentEmail: "a@x.com", coachSummary: "material",
      };
    },
    async listDueForExpiry() { return []; },
  };
  const service = createCxCallWrapCardService({
    cardRepository,
    outboxRepository: {
      async findByIdentity() { return { idemKey: "q1:u1", payload: { outcome: "answered" } }; },
      async insertOnce(row) { calls.correction.push(row); return row; },
    },
    buildCorrectionRow: (input) => ({ idemKey: `${input.queueItemId}:${input.uii}:review-dnc`, payload: { outcome: "dnc" } }),
    writeInterview: async (card) => { calls.interview.push(card.idemKey); return { ok: true }; },
    createAppointment: async ({ appointmentAt, appointmentDate, appointmentTime, appointmentTimezone }) => {
      calls.appointment.push({ appointmentAt, appointmentDate, appointmentTime, appointmentTimezone });
      return { ok: true };
    },
    releaseToCadence: async (card) => { calls.cadence.push(card.idemKey); return { ok: true }; },
    logger: { info() {} },
  });
  return { service, calls };
}

test("PROTOCOL: dnc = interview + correction row; appointment = interview + booking; ✕/expire = interview ONLY", async () => {
  const { service, calls } = makeHarness();

  const dnc = await service.resolve({ idemKey: "k1", action: "dnc", resolvedBy: "a@x.com" });
  assert.equal(dnc.ok, true);
  assert.equal(calls.interview.length, 1, "dnc files the interview (accidental-DNC recoverability)");
  assert.equal(calls.correction.length, 1, "dnc emits the correction ROW — the drain applies app-side (layering law)");
  assert.equal(calls.appointment.length, 0);
  assert.equal(calls.cadence.length, 0);

  const appt = await service.resolve({ idemKey: "k2", action: "appointment", appointmentAt: "2026-07-08T17:00" });
  assert.equal(appt.ok, true);
  assert.equal(calls.appointment.length, 1);
  assert.equal(calls.correction.length, 1, "appointment adds no correction row in v1");
  assert.equal(calls.interview.length, 2);
  assert.equal(calls.cadence.length, 0);

  const dismiss = await service.resolve({ idemKey: "k3", action: "dismissed" });
  const expire = await service.resolve({ idemKey: "k4", action: "expired" });
  assert.equal(dismiss.ok, true);
  assert.equal(expire.ok, true);
  assert.equal(calls.interview.length, 4, "✕ AND expiry still file the interview — a real call reaches the case file");
  assert.equal(calls.correction.length, 1);
  assert.equal(calls.appointment.length, 1);
  assert.deepEqual(calls.cadence, ["k3"], "only the human X click releases to cadence");

  const bad = await service.resolve({ idemKey: "k5", action: "appointment" });
  assert.equal(bad.ok, false, "appointment without a datetime is refused");
  assert.deepEqual(Object.keys(RESOLUTION_RULES).sort(), ["appointment", "dismissed", "dnc", "expired"]);
});

test("APPOINTMENT: explicit date/time/timezone rides through the wrap card effect", async () => {
  const { service, calls } = makeHarness();

  const result = await service.resolve({
    idemKey: "k-appointment-explicit",
    action: "appointment",
    appointmentDate: "2026-07-25",
    appointmentTime: "10:00",
    appointmentTimezone: "America/Los_Angeles",
    resolvedBy: "a@x.com",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.appointment.at(-1), {
    appointmentAt: null,
    appointmentDate: "2026-07-25",
    appointmentTime: "10:00",
    appointmentTimezone: "America/Los_Angeles",
  });
  assert.deepEqual(calls.resolutions.at(-1)?.detail, {
    resolvedBy: "a@x.com",
    detail: {
      appointmentAt: null,
      appointmentDate: "2026-07-25",
      appointmentTime: "10:00",
      appointmentTimezone: "America/Los_Angeles",
    },
  });
});

test("CAS EXACTLY-ONCE: an already-resolved card is a clean no-op — no effects fire twice", async () => {
  const { service, calls } = makeHarness({ resolveResult: null });
  const result = await service.resolve({ idemKey: "k1", action: "dnc" });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(calls.interview.length, 0);
  assert.equal(calls.correction.length, 0);
});

test("SUMMARY IS TEXT: a status object leaking into the coachSummary slot never shadows the payload text (2026-07-07 live find)", () => {
  const { buildWrapCard } = require("../../packages/shared-services/src/cxCallWrapCardService");
  const payload = {
    queueItemId: "q1", uii: "u1", caseId: 101617, domain: "WYNN",
        agentEmail: "a@x.com", outcome: "answered", eventType: "terminal", nextAction: "call_wrap",
    callSummary: "prospect engaged, wants callback after 3pm",
    at: "2026-07-07T17:00:00.000Z",
  };
  // the exact live shape: the enrich bridge's skip-report object in the summary slot
  const card = buildWrapCard({
    row: { idemKey: "k1" },
    payload,
    coachSummary: { skipped: true, reason: "missing-rolling-summary", source: "livecoach_sessions" },
  });
  assert.equal(card.coachSummary, "prospect engaged, wants callback after 3pm", "the payload text wins over any object");
  // and a real string still takes precedence
  const card2 = buildWrapCard({ row: { idemKey: "k2" }, payload, coachSummary: "coach says: close on the levy timeline" });
  assert.equal(card2.coachSummary, "coach says: close on the levy timeline");
  // nothing usable → honest null, never an object
  const card3 = buildWrapCard({ row: { idemKey: "k3" }, payload: { ...payload, callSummary: null }, coachSummary: { skipped: true } });
  assert.equal(card3.coachSummary ?? null, null);
});

test("SUMMARY IS TEXT: the enrich bridge emits text-or-null in coachSummary; the report rides its own field", async () => {
  const { enrichTerminalPacketWithCoachSummary } = require("../../packages/shared-services/src/cxTerminalCoachSummaryBridge");
  // no rolling summary anywhere -> coachSummary null + skip report aside
  const skipped = await enrichTerminalPacketWithCoachSummary(
    { row: {}, payload: { queueItemId: "q1", uii: "u1" } },
    { loadLiveCoachSessionDoc: async () => null },
  );
  assert.equal(skipped.coachSummary ?? null, null, "skip = null in the summary slot, never an object");
  assert.equal(skipped.coachSummaryReport?.skipped, true, "the report survives in its own field");
});
