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
  assert.equal(wrapCardNeeded({ outcome: "answered" }), true);
  assert.equal(wrapCardNeeded({ outcome: "answered", eventType: "terminal" }), true);
  assert.equal(wrapCardNeeded({ outcome: "answered", eventType: "review-dnc" }), false, "corrections never card — no cycles");
  assert.equal(wrapCardNeeded({ outcome: "voicemail" }), false);
  assert.equal(wrapCardNeeded({ outcome: "did_not_connect" }), false);
  assert.equal(wrapCardNeeded({ outcome: "dnc" }), false, "dnc left the disposition row — it lives on the card now");
  assert.equal(wrapCardNeeded({}), false);
});

test("THE 2H CLOCK: the card expires exactly two hours after the call", () => {
  const card = buildWrapCard({
    row: { idemKey: "q1:u1" },
    payload: { queueItemId: "q1", uii: "u1", outcome: "answered", at: "2026-07-06T20:00:00.000Z", caseId: 7, agentEmail: "A@X.com", name: "Lead" },
    coachSummary: "spoke about 941 debt",
  });
  assert.equal(card.idemKey, "q1:u1");
  assert.equal(card.agentEmail, "a@x.com", "agent email normalized");
  assert.equal(card.expiresAt.getTime() - card.calledAt.getTime(), WRAP_CARD_TTL_MS);
  assert.equal(card.coachSummary, "spoke about 941 debt");
});

function makeHarness({ resolveResult } = {}) {
  const calls = { interview: [], correction: [], appointment: [], dnc: [] };
  const cardRepository = {
    async insertOnce(card) { calls.inserted = card; return card; },
    async findByIdemKey() { return null; },
    async listPendingForAgent() { return []; },
    async resolveCard(idemKey, resolution) {
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
    createAppointment: async ({ appointmentAt }) => { calls.appointment.push(appointmentAt); return { ok: true }; },
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

  const appt = await service.resolve({ idemKey: "k2", action: "appointment", appointmentAt: "2026-07-08T17:00" });
  assert.equal(appt.ok, true);
  assert.equal(calls.appointment.length, 1);
  assert.equal(calls.correction.length, 1, "appointment adds no correction row in v1");
  assert.equal(calls.interview.length, 2);

  const dismiss = await service.resolve({ idemKey: "k3", action: "dismissed" });
  const expire = await service.resolve({ idemKey: "k4", action: "expired" });
  assert.equal(dismiss.ok, true);
  assert.equal(expire.ok, true);
  assert.equal(calls.interview.length, 4, "✕ AND expiry still file the interview — a real call reaches the case file");
  assert.equal(calls.correction.length, 1);
  assert.equal(calls.appointment.length, 1);

  const bad = await service.resolve({ idemKey: "k5", action: "appointment" });
  assert.equal(bad.ok, false, "appointment without a datetime is refused");
  assert.deepEqual(Object.keys(RESOLUTION_RULES).sort(), ["appointment", "dismissed", "dnc", "expired"]);
});

test("CAS EXACTLY-ONCE: an already-resolved card is a clean no-op — no effects fire twice", async () => {
  const { service, calls } = makeHarness({ resolveResult: null });
  const result = await service.resolve({ idemKey: "k1", action: "dnc" });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(calls.interview.length, 0);
  assert.equal(calls.correction.length, 0);
});
