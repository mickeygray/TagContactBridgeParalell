"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// THE SERVING BOUNDARY PINS (2026-07-07): the lane registry + both dispatchers, up to the
// point where leads are PUBLISHED into the per-agent first-touch and appointment
// campaigns. Consumption (F2) is the next phase — nothing here touches the drain.

const {
  LANES,
  buildLaneExternId,
  parseLaneExternId,
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
  assert.deepEqual(parseLaneExternId(ft), { lane: "firstTouch", domain: "wynn", queueItemId: "abc123" });
  const apt = buildLaneExternId("appointment", { appointmentId: "appointment:uuid-1" });
  assert.equal(apt, "cxapt-appointment:uuid-1");
  assert.equal(parseLaneFromExternId(apt), "appointment");
  assert.deepEqual(parseLaneExternId(apt), { lane: "appointment", appointmentId: "appointment:uuid-1" });
  assert.equal(parseLaneFromExternId("cxbl-wynn-tok-q1"), "bulk");
  assert.deepEqual(parseLaneExternId("cxft-WYNN-row-with-dash"), {
    lane: "firstTouch",
    domain: "WYNN",
    queueItemId: "row-with-dash",
  });
  assert.equal(parseLaneExternId("cxft-badshape"), null);
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
    resolveWindowMode: () => "drip", // tests pin the clock; the matrix pin covers the real fn
    resolveQueueMap: () => [
      { agentEmail: "brad@x.com", campaignId: "111" },
      { agentEmail: "amy@x.com", campaignId: "222" },
    ],
    loadPendingRows: async (limit) => state.rows.filter((r) => !r.claimed).slice(0, limit || 25),
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
  // PER-AGENT BATCHING: one loadLeads call per agent per page, not per lead
  assert.equal(state.published.length, 2, "two agents = two batch publishes");
  const byCampaign = Object.fromEntries(state.published.map((p) => [p.campaignId, p.candidates.length]));
  assert.deepEqual(byCampaign, { 111: 2, 222: 1 }, "round-robin: brad gets rows 1+3, amy gets row 2");
  for (const p of state.published) {
    assert.equal(p.dialPriority, "IMMEDIATE");
    for (const c of p.candidates) assert.match(c.externId, /^cxft-(wynn|tag)-q\d$/);
  }
  assert.equal(state.stamped.length, 3, "every accepted lead stamped dispatched");
  // second tick: everything claimed — nothing re-publishes
  const again = await dispatcher.tickOnce({});
  assert.equal(state.published.length, 2, "no double-dispatch");
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
  assert.equal(result.pages, 1, "a rejected page does not burst-loop forever");

  const off = createCxFirstTouchDispatcher({ isEnabled: () => false, resolveWindowMode: () => "drip" });
  assert.deepEqual(await off.tickOnce({}), { skipped: true, reason: "flag-off" });
  const noMap = createCxFirstTouchDispatcher({
    isEnabled: () => true,
    resolveWindowMode: () => "drip",
    resolveQueueMap: () => [],
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(await noMap.tickOnce({}), { skipped: true, reason: "empty-queue-map" });
});

test("FIRST-TOUCH BURST: a backlog drains in one tick — pages keep coming until empty", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    _id: `q${i + 1}`, domain: "WYNN", caseId: i + 1, phone: `818555${String(i).padStart(4, "0")}`, name: `Lead ${i + 1}`,
  }));
  const { state, dispatcher } = fakeFirstTouchWorld({ rows });
  const result = await dispatcher.tickOnce({ limit: 25 });
  assert.equal(result.dispatched, 60, "the whole weekend backlog lands in one tick");
  assert.equal(result.pages, 3, "25 + 25 + 10");
  const total = state.published.reduce((sum, p) => sum + p.candidates.length, 0);
  assert.equal(total, 60);
});

test("THE CLOCK: drip 8-5 weekdays, hold 5-6, assign evenings + weekends; force-override wins", () => {
  const { deriveFirstTouchWindowMode } = require("../../packages/shared-services/src/cxFirstTouchDispatchService");
  const tz = { timeZone: "America/Los_Angeles" };
  // Wed 2026-07-08: 10am PT = 17:00Z, 5:30pm PT = 00:30Z(+1), 9pm PT = 04:00Z(+1)
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-08T17:00:00Z"), tz), "drip", "10am Wed");
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-09T00:30:00Z"), tz), "hold", "5:30pm Wed — agents finishing");
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-09T04:00:00Z"), tz), "assign", "9pm Wed — the loader");
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-09T13:00:00Z"), tz), "assign", "6am Thu — still loading");
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-11T18:00:00Z"), tz), "assign", "Saturday 11am — weekend buffers");
  assert.equal(deriveFirstTouchWindowMode(new Date("2026-07-11T18:00:00Z"), { ...tz, force: "drip" }), "drip", "force wins (tests/off-hours drills)");
});

test("THE 6PM LOADER: assign mode round-robins ASSIGNMENTS (no RingCX), CAS-safe, burst-until-empty", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ _id: `q${i + 1}`, caseId: i + 1 }));
  const assigned = [];
  const dispatcher = createCxFirstTouchDispatcher({
    isEnabled: () => true,
    resolveWindowMode: () => "assign",
    resolveQueueMap: () => [
      { agentEmail: "brad@x.com", campaignId: "111" },
      { agentEmail: "amy@x.com", campaignId: "222" },
    ],
    loadUnassignedRows: async (limit) => rows.filter((r) => !r.assignment).slice(0, limit || 25),
    assignRow: async (rowId, assignment) => {
      const row = rows.find((r) => String(r._id) === String(rowId));
      if (!row || row.assignment) return false;
      row.assignment = assignment;
      assigned.push({ rowId: String(rowId), agentEmail: assignment.agentEmail });
      return true;
    },
    publishBatch: async () => { throw new Error("assign mode must NEVER publish"); },
    logger: { info() {}, warn() {} },
  });
  const result = await dispatcher.tickOnce({ now: new Date("2026-07-09T04:00:00Z") });
  assert.equal(result.mode, "assign");
  assert.equal(result.assigned, 5, "the whole buffer assigned in one tick");
  const perAgent = assigned.reduce((acc, a) => ({ ...acc, [a.agentEmail]: (acc[a.agentEmail] || 0) + 1 }), {});
  assert.deepEqual(
    Object.values(perAgent).sort(),
    [2, 3],
    "round-robin fairness: 5 rows across 2 agents = 3/2 split",
  );
  // second tick: everything assigned — nothing left, nothing published
  const again = await dispatcher.tickOnce({ now: new Date("2026-07-09T04:05:00Z") });
  assert.equal(again.assigned, 0);
});

test("THE HOLD WINDOW: 5-6pm the dispatcher does nothing at all", async () => {
  const dispatcher = createCxFirstTouchDispatcher({
    isEnabled: () => true,
    resolveWindowMode: () => "hold",
    resolveQueueMap: () => [{ agentEmail: "brad@x.com", campaignId: "111" }],
    loadPendingRows: async () => { throw new Error("hold must not read"); },
    loadUnassignedRows: async () => { throw new Error("hold must not read"); },
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(await dispatcher.tickOnce({}), { skipped: true, mode: "hold", reason: "hold-window" });
});

test("THE POST-8AM QUERY: assigned first-touch rows are agent-scoped, arrival-ordered material", () => {
  const { buildAssignedFirstTouchQuery } = require("../../packages/shared-repositories/src/cxDialQueueRepository");
  const q = buildAssignedFirstTouchQuery("WYNN", "Brad@X.com", new Date("2026-07-09T15:00:00Z"));
  assert.equal(q["metadata.firstTouchPending"], true);
  assert.equal(q["metadata.firstTouchDispatch"], null, "drip-dispatched rows never double-serve");
  assert.equal(q["metadata.firstTouchAssignment.agentEmail"], "brad@x.com", "normalized agent scope");
  assert.equal(q.state, "ready");
  assert.ok(q.releaseAt.$lte instanceof Date, "legal window respected");
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
      legalDialAt: "2026-07-08T16:00:00.000Z", status: "due", rcxDispatch: null },
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

test("APPOINTMENT WINDOW FIX: the ops window never pushes an appointment — only the lead-legal window floors it", () => {
  const { resolveQueueDialTimeWindow } = require("../../packages/shared-services/src/cxQueuePolicyService");
  // 6:30pm PT on a Wednesday — inside lead-legal hours, AFTER the operational close.
  const eveningAppt = new Date("2026-07-08T01:30:00.000Z"); // = Tue 6:30pm PT
  const item = { payloadSnapshot: { state: "CA", timezone: "America/Los_Angeles" } };
  const withOps = resolveQueueDialTimeWindow(item, eveningAppt);
  const withoutOps = resolveQueueDialTimeWindow(item, eveningAppt, { ignoreOperationalWindow: true });
  assert.equal(withoutOps.allowed, true, "the appointment fires at ITS time");
  assert.equal(withoutOps.nextAllowedAt.getTime(), eveningAppt.getTime());
  assert.equal(withOps.allowed, false, "the default (cadence) behavior still respects the ops window");
  assert.ok(withOps.nextAllowedAt.getTime() > eveningAppt.getTime(), "cadence pushes forward as before");
});

test("LANE RECOGNITION (Mickey's modal ruling): uii-gated, three-source extern resolution, registry-fed", async () => {
  const { detectLaneCallsForAccount } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
  const { getLaneCall, clearLaneCall, LANE_CALL_TTL_MS } = require("../../packages/shared-services/src/cxLaneCallRegistry");
  clearLaneCall("bhansen@x.com");
  clearLaneCall("cbolt@x.com");

  const activeCalls = [
    // no uii = NO MODAL (Mickey: "only fire the ui when theres a uii for the call")
    { externalId: "cxft-wynn-rowNoUii", callState: "RINGING" },
    // bulk extern = the session UI's job, never the modal
    { externalId: "cxbl-wynn-tok-q9", uii: "u-bulk", callState: "ACTIVE" },
    // first touch with a uii -> resolves through the queue row source
    { externalId: "cxft-wynn-row123", uii: "u-ft-1", callState: "ACTIVE" },
    // appointment with a uii -> resolves through the appointment source
    { externalId: "cxapt-appointment:a77", uii: "u-apt-1", callState: "RINGING" },
    // unknown extern = not ours
    { externalId: "manual-555", uii: "u-x", callState: "ACTIVE" },
  ];
  const seen = await detectLaneCallsForAccount(activeCalls, {
    loadFirstTouchRow: async (queueItemId) => {
      assert.equal(queueItemId, "row123", "the row id rides IN the cxft extern");
      return {
        caseId: 42, name: "Fresh Lead", domain: "WYNN", phone: "8185550001",
        createdAt: "2026-07-08T15:00:00.000Z",
        metadata: { firstTouchDispatch: { agentEmail: "bhansen@x.com" } },
      };
    },
    loadAppointment: async (appointmentId) => {
      assert.equal(appointmentId, "appointment:a77", "the extern IS the appointment key");
      return {
        caseId: 43, prospectName: "Booked Person", domain: "WYNN",
        agentEmail: "cbolt@x.com", appointmentAt: "2026-07-08T21:30:00.000Z",
      };
    },
  });
  assert.deepEqual(seen.sort(), ["bhansen@x.com", "cbolt@x.com"], "exactly the two lane calls recognized");

  const ft = getLaneCall("bhansen@x.com");
  assert.equal(ft.lane, "firstTouch");
  assert.equal(ft.uii, "u-ft-1");
  assert.equal(ft.caseId, 42);
  assert.equal(ft.meta.phoneLast4, "0001");

  const apt = getLaneCall("CBOLT@X.COM"); // case-insensitive read
  assert.equal(apt.lane, "appointment");
  assert.equal(apt.meta.appointmentAt, "2026-07-08T21:30:00.000Z");

  // TTL: a call that stops refreshing dies -> the modal auto-dismisses
  assert.equal(getLaneCall("bhansen@x.com", { nowMs: Date.now() + LANE_CALL_TTL_MS + 1000 }), null);
  clearLaneCall("cbolt@x.com");
});

test("LANE RECOGNITION: a failing source never breaks the poller tick (fail-soft per call)", async () => {
  const { detectLaneCallsForAccount } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
  const seen = await detectLaneCallsForAccount(
    [{ externalId: "cxft-wynn-boom", uii: "u-1", callState: "ACTIVE" }],
    { loadFirstTouchRow: async () => { throw new Error("mongo blip"); } },
  );
  assert.deepEqual(seen, [], "the blip is swallowed; no modal beats a broken tick");
});

test("F2 CONSUMPTION: a dispositioned first-touch call persists a REAL terminal to the row inside the extern", async () => {
  const { persistLaneCallConsumption } = require("../../packages/shared-services/src/cxBulkLoadRuntime.js");
  const inserted = [];
  const result = await persistLaneCallConsumption({
    laneCall: {
      lane: "firstTouch",
      externId: "cxft-wynn-row42",
      uii: "u-ft-9",
      domain: "WYNN",
      caseId: 42,
      phone: "+1 (818) 555-0001",
      name: "Fresh Lead",
    },
    session: { sessionId: "lane:brad@x.com" },
    outcome: "answered",
    agentEmail: "brad@x.com",
    deps: { insertOutboxRow: async (row) => { inserted.push(row); return row; } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.lane, "firstTouch");
  assert.equal(inserted.length, 1);
  const row = inserted[0];
  assert.equal(row.queueItemId, "row42", "the REAL queue row id parsed from the extern");
  assert.equal(row.outcome, "answered");
  assert.equal(row.phone, "8185550001", "the daily terminal ledger receives a full normalized phone");
  assert.equal(row.payload.phone, "8185550001");
  assert.equal(row.payload.eventType, "terminal", "the drain treats it like any terminal — wrap card, cadence, flag release");
  assert.equal(row.payload.source, "lane-call-disposition");
  assert.ok(row.idemKey.includes("row42"), "idemKey keyed to the row — exactly-once with any other terminal");
});

test("F2 CONSUMPTION: a dispositioned appointment call resolves the appointment AND terminals its queue row", async () => {
  const { persistLaneCallConsumption } = require("../../packages/shared-services/src/cxBulkLoadRuntime.js");
  const inserted = [];
  const resolved = [];
  const result = await persistLaneCallConsumption({
    laneCall: {
      lane: "appointment",
      externId: "cxapt-appointment:a99",
      uii: "u-apt-9",
      domain: "WYNN",
      caseId: 43,
      meta: { phone: "818-555-0002" },
      name: "Booked Person",
    },
    session: { sessionId: "lane:brad@x.com" },
    outcome: "answered",
    agentEmail: "brad@x.com",
    deps: {
      insertOutboxRow: async (row) => { inserted.push(row); return row; },
      resolveAppointment: async (input) => {
        resolved.push(input);
        return { ok: true, appointment: { appointmentId: "appointment:a99", cxQueueRecordId: "qrow7" } };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.appointmentResolved, true);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].queueItem.metadata.appointmentId, "appointment:a99", "the extern IS the appointment key");
  assert.equal(resolved[0].disposition, "answered", "kept/missed rides resolvedDisposition");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].phone, "8185550002");
  assert.equal(inserted[0].queueItemId, "qrow7", "the appointment's queue row gets its terminal — cadence counts the attempt");
});

test("F2 CONSUMPTION: lane terminals fail closed without a canonical case or full phone", async () => {
  const { persistLaneCallConsumption } = require("../../packages/shared-services/src/cxBulkLoadRuntime.js");
  const inserted = [];
  const result = await persistLaneCallConsumption({
    laneCall: {
      lane: "firstTouch",
      externId: "cxft-wynn-row42",
      uii: "u-ft-no-identity",
      domain: "WYNN",
      caseId: null,
      meta: { phoneLast4: "0001" },
    },
    session: { sessionId: "lane:brad@x.com" },
    outcome: "answered",
    deps: { insertOutboxRow: async (row) => { inserted.push(row); return row; } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.terminalPersisted, false);
  assert.equal(inserted.length, 0);
});

test("F2 CONSUMPTION: a bulk extern is not lane material; consumption failing never throws", async () => {
  const { persistLaneCallConsumption } = require("../../packages/shared-services/src/cxBulkLoadRuntime.js");
  const bulk = await persistLaneCallConsumption({
    laneCall: { lane: "bulk", externId: "cxbl-wynn-tok-q1", uii: "u-1" },
    session: { sessionId: "s" },
    outcome: "answered",
  });
  assert.equal(bulk.ok, false);
  assert.equal(bulk.reason, "bulk-extern-not-lane");
});

test("BORING MODE: first-contact round robin routes into the main queue and never publishes", async () => {
  const rows = [{ _id: "q1" }, { _id: "q2" }, { _id: "q3" }];
  const routed = [];
  const dispatcher = createCxFirstTouchDispatcher({
    isEnabled: () => true,
    isMainQueueMode: () => true,
    resolveWindowMode: () => "drip",
    resolveQueueMap: () => [
      { agentEmail: "brad@x.com", campaignId: "111" },
      { agentEmail: "amy@x.com", campaignId: "222" },
    ],
    resolveMainQueueAgent: async (agent) => ({
      ...agent,
      agentExtensionId: agent.agentEmail.startsWith("brad") ? "ext-1" : "ext-2",
    }),
    loadPendingRows: async (limit) => rows.filter((row) => !row.routed).slice(0, limit),
    activateRow: async (rowId, assignment) => {
      rows.find((row) => row._id === rowId).routed = true;
      routed.push({ rowId, assignment });
      return true;
    },
    publishBatch: async () => { throw new Error("boring mode must not publish directly"); },
    logger: { info() {}, warn() {} },
  });

  const result = await dispatcher.tickOnce({ limit: 25 });

  assert.equal(result.routedTo, "boring-dial-queue");
  assert.equal(result.queued, 3);
  assert.deepEqual(routed.map((row) => row.assignment.agentExtensionId), ["ext-1", "ext-2", "ext-1"]);
});
