"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// THE SERVING BOUNDARY PINS (2026-07-07): the lane registry + both dispatchers, up to the
// point where leads are PUBLISHED into the per-agent first-touch and appointment
// campaigns. Consumption (F2) is the next phase — nothing here touches the drain.

const {
  LANES,
  buildLaneExternId,
  parseLaneFromExternId,
  parseAgentQueueMap,
} = require("../../packages/shared-services/src/cxLaneRegistry");
const {
  createCxFirstTouchDispatcher,
  assignRoundRobin,
} = require("../../packages/shared-services/src/cxFirstTouchDispatchService");
const {
  createCxAppointmentDispatcher,
  deriveAppointmentDispatchDue,
} = require("../../packages/shared-services/src/cxAppointmentDispatchService");

test("LANE REGISTRY: extern ids build and parse round-trip; bulk externs are recognized too", () => {
  assert.equal(LANES.bulk, "cxbl");
  const ft = buildLaneExternId("firstTouch", { domain: "WYNN", queueItemId: "abc123" });
  assert.equal(ft, "cxft-wynn-abc123");
  assert.equal(parseLaneFromExternId(ft), "firstTouch");
  const apt = buildLaneExternId("appointment", { appointmentId: "appointment:uuid-1" });
  assert.equal(apt, "cxapt-appointment:uuid-1");
  assert.equal(parseLaneFromExternId(apt), "appointment");
  assert.equal(parseLaneFromExternId("cxbl-wynn-tok-q1"), "bulk");
  assert.equal(parseLaneFromExternId("manual-dial-123"), null);
  assert.throws(() => buildLaneExternId("firstTouch", { domain: "WYNN" }), /queueItemId/);
});

test("LANE REGISTRY: the queue map parser survives every malformed shape and normalizes emails", () => {
  assert.deepEqual(parseAgentQueueMap(null), []);
  assert.deepEqual(parseAgentQueueMap("not json"), []);
  assert.deepEqual(parseAgentQueueMap("[1,2]"), []);
  const parsed = parseAgentQueueMap(JSON.stringify({
    "Brad@X.com": 111,
    "amy@x.com": { campaignId: 222 },
    "broken@x.com": {},
    "": 999,
  }));
  assert.deepEqual(parsed, [
    { agentEmail: "amy@x.com", campaignId: "222" },
    { agentEmail: "brad@x.com", campaignId: "111" },
  ]);
});

test("ROUND ROBIN: deterministic, offset-fair, never throws on empty", () => {
  const rows = ["r1", "r2", "r3"].map((id) => ({ id }));
  const agents = [{ agentEmail: "a" }, { agentEmail: "b" }];
  const first = assignRoundRobin(rows, agents, 0).map((x) => x.agent.agentEmail);
  assert.deepEqual(first, ["a", "b", "a"]);
  const offset = assignRoundRobin(rows, agents, 1).map((x) => x.agent.agentEmail);
  assert.deepEqual(offset, ["b", "a", "b"], "the cursor keeps rotation fair across ticks");
  assert.deepEqual(assignRoundRobin([], agents), []);
  assert.deepEqual(assignRoundRobin(rows, []), []);
});

function fakeFirstTouchWorld({ rows, publishReject = false } = {}) {
  const state = {
    rows: rows.map((r) => ({ ...r })),
    published: [],
    stamped: [],
    released: [],
  };
  const deps = {
    isEnabled: () => true,
    resolveQueueMap: () => [
      { agentEmail: "brad@x.com", campaignId: "111" },
      { agentEmail: "amy@x.com", campaignId: "222" },
    ],
    loadPendingRows: async () => state.rows.filter((r) => !r.claimed),
    claimRow: async (rowId) => {
      const row = state.rows.find((r) => String(r._id) === String(rowId));
      if (!row || row.claimed) return false;
      row.claimed = true;
      return true;
    },
    stampRow: async (rowId, fields) => { state.stamped.push({ rowId: String(rowId), fields }); },
    releaseClaim: async (rowId) => {
      const row = state.rows.find((r) => String(r._id) === String(rowId));
      if (row) row.claimed = false;
      state.released.push(String(rowId));
    },
    publishBatch: async (client, input) => {
      state.published.push(input);
      if (publishReject) return { accepted: [], rejected: [{ reason: "TEST_REJECT" }] };
      return { accepted: input.candidates, rejected: [] };
    },
  };
  return { state, dispatcher: createCxFirstTouchDispatcher({ ...deps, logger: { info() {}, warn() {} } }) };
}

test("FIRST-TOUCH DISPATCH: stamped rows publish round-robin to per-agent campaigns, IMMEDIATE, cxft externs, claims stick", async () => {
  const { state, dispatcher } = fakeFirstTouchWorld({
    rows: [
      { _id: "q1", domain: "WYNN", caseId: 1, phone: "8185550001", name: "New Lead 1" },
      { _id: "q2", domain: "WYNN", caseId: 2, phone: "8185550002", name: "New Lead 2" },
      { _id: "q3", domain: "TAG", caseId: 3, phone: "8185550003", name: "New Lead 3" },
    ],
  });
  const result = await dispatcher.tickOnce({ now: new Date("2026-07-08T08:00:00Z") });
  assert.equal(result.dispatched, 3);
  assert.equal(state.published.length, 3, "one publish per lead (single-candidate batches)");
  const campaigns = state.published.map((p) => p.campaignId);
  assert.deepEqual(campaigns.sort(), ["111", "111", "222"], "round-robin across the two agents");
  for (const p of state.published) {
    assert.equal(p.dialPriority, "IMMEDIATE");
    assert.match(p.candidates[0].externId, /^cxft-(wynn|tag)-q\d$/);
  }
  assert.equal(state.stamped.length, 3, "every publish stamped dispatched");
  // second tick: everything claimed — nothing re-publishes
  const again = await dispatcher.tickOnce({});
  assert.equal(state.published.length, 3, "no double-dispatch");
});

test("FIRST-TOUCH DISPATCH: a rejected publish releases the claim for retry; flag-off and empty-map are inert", async () => {
  const { state, dispatcher } = fakeFirstTouchWorld({
    rows: [{ _id: "q1", domain: "WYNN", caseId: 1, phone: "8185550001", name: "X" }],
    publishReject: true,
  });
  const result = await dispatcher.tickOnce({});
  assert.equal(result.failed, 1);
  assert.deepEqual(state.released, ["q1"], "claim released — the next tick retries");
  assert.equal(state.stamped.length, 0, "no dispatched stamp on failure");

  const off = createCxFirstTouchDispatcher({ isEnabled: () => false });
  assert.deepEqual(await off.tickOnce({}), { skipped: true, reason: "flag-off" });
  const noMap = createCxFirstTouchDispatcher({
    isEnabled: () => true,
    resolveQueueMap: () => [],
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(await noMap.tickOnce({}), { skipped: true, reason: "empty-queue-map" });
});

test("APPOINTMENT DUE MATH: the moment of the call, never before the legal window", () => {
  const appt = {
    appointmentAt: "2026-07-08T21:00:00.000Z",
    legalDialAt: "2026-07-08T16:00:00.000Z",
  };
  assert.equal(deriveAppointmentDispatchDue(appt, { leadMs: 0 }).toISOString(), "2026-07-08T21:00:00.000Z");
  assert.equal(
    deriveAppointmentDispatchDue(appt, { leadMs: 2 * 60_000 }).toISOString(),
    "2026-07-08T20:58:00.000Z",
    "lead time pulls dispatch earlier",
  );
  const legalBound = deriveAppointmentDispatchDue(
    { ...appt, legalDialAt: "2026-07-08T20:59:30.000Z" },
    { leadMs: 2 * 60_000 },
  );
  assert.equal(legalBound.toISOString(), "2026-07-08T20:59:30.000Z", "legalDialAt is the floor");
  assert.equal(deriveAppointmentDispatchDue({}, {}), null, "no appointmentAt = never due");
});

test("APPOINTMENT DISPATCH: due appointments publish to the OWNING agent's campaign with the CxApt key; not-due wait; unmapped agents skip loudly", async () => {
  const now = new Date("2026-07-08T21:00:05.000Z");
  const state = { published: [], stamped: [], released: [] };
  const appts = [
    { appointmentId: "appointment:a1", domain: "WYNN", caseId: 1, agentEmail: "brad@x.com",
      phone: "8185550001", prospectName: "Priya R", appointmentAt: "2026-07-08T21:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z", status: "scheduled", rcxDispatch: null },
    { appointmentId: "appointment:a2", domain: "WYNN", caseId: 2, agentEmail: "brad@x.com",
      phone: "8185550002", prospectName: "Later Person", appointmentAt: "2026-07-08T23:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z", status: "scheduled", rcxDispatch: null },
    { appointmentId: "appointment:a3", domain: "WYNN", caseId: 3, agentEmail: "ghost@x.com",
      phone: "8185550003", prospectName: "Unmapped", appointmentAt: "2026-07-08T21:00:00.000Z",
      legalDialAt: "2026-07-08T16:00:00.000Z", status: "scheduled", rcxDispatch: null },
  ];
  const dispatcher = createCxAppointmentDispatcher({
    isEnabled: () => true,
    resolveQueueMap: () => [{ agentEmail: "brad@x.com", campaignId: "333" }],
    resolveLeadMs: () => 0,
    listDispatchable: async () => appts.filter((a) => !a.rcxDispatch),
    claimAppointment: async (id, claim) => {
      const appt = appts.find((a) => a.appointmentId === id);
      if (!appt || appt.rcxDispatch) return false;
      appt.rcxDispatch = claim;
      return true;
    },
    stampAppointment: async (id, fields) => { state.stamped.push({ id, fields }); },
    releaseClaim: async (id) => {
      const appt = appts.find((a) => a.appointmentId === id);
      if (appt) appt.rcxDispatch = null;
      state.released.push(id);
    },
    publishBatch: async (client, input) => { state.published.push(input); return { accepted: input.candidates, rejected: [] }; },
    logger: { info() {}, warn() {} },
  });

  const result = await dispatcher.tickOnce({ now });
  assert.equal(result.dispatched, 1, "only the due, mapped appointment dispatches");
  assert.equal(result.waiting, 1, "the 23:00 appointment waits for its moment");
  assert.equal(state.published.length, 1);
  assert.equal(state.published[0].campaignId, "333", "the OWNING agent's campaign — never borrowed");
  assert.equal(state.published[0].dialPriority, "IMMEDIATE");
  assert.equal(state.published[0].candidates[0].externId, "cxapt-appointment:a1", "the CxApt key IS the extern");
  // second tick: a1 claimed, a2 still waiting, a3 still unmapped — nothing new
  const again = await dispatcher.tickOnce({ now });
  assert.equal(state.published.length, 1, "exactly-once via the rcxDispatch CAS");
});
