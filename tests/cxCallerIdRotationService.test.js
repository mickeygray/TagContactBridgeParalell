"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCxCallerIdRotationService,
  buildRotationPlan,
  filterRotationConfig,
  listActiveCampaignRows,
  pickNextCallerId,
  withinBusinessHours,
} = require("../packages/shared-services/src/cxCallerIdRotationService");

test("Boring filters the registered master pool to its owned dial groups", () => {
  const config = {
    pools: { "1011": ["111"], "1014": ["222"], "1067": ["333"], "1068": ["444"] },
    agentOrder: ["1011", "1014", "1067", "1068"].map((dialGroupId) => ({ dialGroupId })),
  };
  const filtered = filterRotationConfig(config, ["1011", "1067", "1068"]);
  assert.deepEqual(Object.keys(filtered.pools), ["1011", "1067", "1068"]);
  assert.deepEqual(filtered.agentOrder.map((row) => row.dialGroupId), ["1011", "1067", "1068"]);
});

test("an empty Boring filter preserves the complete registered master pool", () => {
  const config = { pools: { "1011": ["111"] }, agentOrder: [{ dialGroupId: "1011" }] };
  assert.deepEqual(filterRotationConfig(config, []), config);
});

test("campaign reads stay inside Boring's owned dial groups", async () => {
  const listed = [];
  const rows = await listActiveCampaignRows({
    listDialGroups: async () => [{ dialGroupId: "1011" }, { dialGroupId: "1014" }, { dialGroupId: "1067" }],
    listCampaigns: async (groupId) => {
      listed.push(groupId);
      return [{ campaignId: `${groupId}-bulk`, active: true, callerId: "8184625451" }];
    },
    getCampaign: async () => null,
  }, ["1011", "1067"]);
  assert.deepEqual(listed, ["1011", "1067"]);
  assert.deepEqual(rows.map((row) => row.groupId), ["1011", "1067"]);
});

test("pickNextCallerId: stateless round-robin", () => {
  const pool = ["8184625451", "7472933389", "7473181179"];
  assert.equal(pickNextCallerId(pool, "8184625451"), "7472933389");
  assert.equal(pickNextCallerId(pool, "7472933389"), "7473181179");
  assert.equal(pickNextCallerId(pool, "7473181179"), "8184625451"); // wraps
});

test("pickNextCallerId: current not in pool -> pool[0]; formatting tolerant", () => {
  const pool = ["8184625451", "7472933389"];
  assert.equal(pickNextCallerId(pool, "9999999999"), "8184625451");
  assert.equal(pickNextCallerId(pool, ""), "8184625451");
  assert.equal(pickNextCallerId(pool, "+1 (818) 462-5451"), "7472933389"); // normalizes current
});

test("pickNextCallerId: pool with < 2 numbers -> null (never rotates a single number)", () => {
  assert.equal(pickNextCallerId(["8184625451"], "8184625451"), null);
  assert.equal(pickNextCallerId([], ""), null);
});

test("buildRotationPlan: one next per agent, applied to all active campaigns", () => {
  const pools = { "1011": ["8184625451", "7472933389", "7473181179"] };
  const agentOrder = [{ order: 1, name: "Sean", dialGroupId: "1011" }];
  const campaignRows = [
    { groupId: "1011", campaignId: "A", active: true, callerId: "8184625451" },
    { groupId: "1011", campaignId: "B", active: true, callerId: "8184625451" },
    { groupId: "1011", campaignId: "C", active: true, callerId: "8184625451" },
  ];
  const plan = buildRotationPlan({ pools, agentOrder, campaignRows });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].skip, undefined);
  assert.equal(plan[0].current, "8184625451");
  assert.equal(plan[0].next, "7472933389");
  assert.equal(plan[0].campaigns.length, 3);
});

test("buildRotationPlan: divergent presented numbers converge on the pool member's next", () => {
  const pools = { "1011": ["8184625451", "7472933389", "7473181179"] };
  const agentOrder = [{ order: 1, name: "Sean", dialGroupId: "1011" }];
  const campaignRows = [
    { groupId: "1011", campaignId: "A", active: true, callerId: "7472933389" }, // in pool
    { groupId: "1011", campaignId: "B", active: true, callerId: "5555555555" }, // stray
  ];
  const plan = buildRotationPlan({ pools, agentOrder, campaignRows });
  assert.equal(plan[0].current, "7472933389"); // prefers the pool member
  assert.equal(plan[0].next, "7473181179");
});

test("buildRotationPlan: skips no-active-campaigns and pool<2", () => {
  const pools = { "1011": ["8184625451", "7472933389"], "1012": ["9498893027"] };
  const agentOrder = [
    { order: 1, name: "Sean", dialGroupId: "1011" },
    { order: 2, name: "Bruce", dialGroupId: "1012" },
    { order: 3, name: "Nobody", dialGroupId: "9999" },
  ];
  const campaignRows = [
    { groupId: "1011", campaignId: "A", active: true, callerId: "8184625451" },
    { groupId: "1012", campaignId: "Z", active: true, callerId: "9498893027" },
    // group 9999 has no rows
  ];
  const plan = buildRotationPlan({ pools, agentOrder, campaignRows });
  const byGroup = Object.fromEntries(plan.map((p) => [p.dialGroupId, p]));
  assert.equal(byGroup["1011"].skip, undefined);
  assert.match(byGroup["1012"].skip, /pool-too-small/);
  assert.equal(byGroup["9999"].skip, "no-active-campaigns");
});

test("buildRotationPlan: inactive campaigns are never rotated", () => {
  const pools = { "1011": ["8184625451", "7472933389"] };
  const agentOrder = [{ order: 1, name: "Sean", dialGroupId: "1011" }];
  const campaignRows = [
    { groupId: "1011", campaignId: "A", active: false, callerId: "8184625451" },
  ];
  const plan = buildRotationPlan({ pools, agentOrder, campaignRows });
  assert.equal(plan[0].skip, "no-active-campaigns");
});

function makeStubClient(store) {
  // store: Map campaignId -> { campaignId, groupId, callerId, other }
  const updates = [];
  return {
    updates,
    listDialGroups: async () => [{ dialGroupId: "1011" }],
    listCampaigns: async (groupId) => [...store.values()]
      .filter((c) => c.groupId === String(groupId))
      .map((c) => ({ campaignId: c.campaignId, isActive: 1, callerId: c.callerId })),
    getCampaign: async (id) => ({ ...store.get(String(id)) }),
    updateCampaign: async (id, full) => {
      const prev = store.get(String(id));
      // prove the full object rides through unchanged except the caller-id fields
      assert.equal(full.other, prev.other, "non-callerId fields must ride unchanged");
      store.set(String(id), { ...prev, callerId: full.callerId, callerIdE164: full.callerIdE164 });
      updates.push({ id: String(id), callerId: full.callerId });
    },
  };
}

test("rotateOnce dry-run: computes the plan, writes NOTHING", async () => {
  const store = new Map([
    ["A", { campaignId: "A", groupId: "1011", callerId: "8184625451", other: "x" }],
    ["B", { campaignId: "B", groupId: "1011", callerId: "8184625451", other: "y" }],
  ]);
  const client = makeStubClient(store);
  const svc = createCxCallerIdRotationService({
    client,
    config: { pools: { "1011": ["8184625451", "7472933389"] }, agentOrder: [{ dialGroupId: "1011", name: "Sean" }] },
    logger: { info() {}, error() {} },
  });
  const res = await svc.rotateOnce({ dryRun: true, enforceBusinessHours: false });
  assert.equal(res.dryRun, true);
  assert.equal(res.moves.length, 1);
  assert.equal(res.moves[0].next, "7472933389");
  assert.equal(client.updates.length, 0, "dry-run must not write");
  assert.equal(store.get("A").callerId, "8184625451", "store untouched");
});

test("rotateOnce armed: sets next on ALL the agent's campaigns and verifies", async () => {
  const store = new Map([
    ["A", { campaignId: "A", groupId: "1011", callerId: "8184625451", other: "x" }],
    ["B", { campaignId: "B", groupId: "1011", callerId: "8184625451", other: "y" }],
    ["C", { campaignId: "C", groupId: "1011", callerId: "8184625451", other: "z" }],
  ]);
  const client = makeStubClient(store);
  const svc = createCxCallerIdRotationService({
    client,
    config: { pools: { "1011": ["8184625451", "7472933389", "7473181179"] }, agentOrder: [{ dialGroupId: "1011", name: "Sean" }] },
    logger: { info() {}, error() {} },
  });
  const res = await svc.rotateOnce({ dryRun: false, enforceBusinessHours: false });
  assert.equal(res.ok, true);
  assert.equal(res.failed, 0);
  assert.equal(client.updates.length, 3, "all three campaigns written");
  for (const id of ["A", "B", "C"]) {
    assert.equal(store.get(id).callerId, "7472933389", `${id} moved to next`);
    assert.equal(store.get(id).callerIdE164, "+17472933389");
  }
});

test("rotateOnce: outside business hours is a no-op", async () => {
  const client = makeStubClient(new Map());
  const svc = createCxCallerIdRotationService({
    client,
    config: { pools: {}, agentOrder: [] },
    logger: { info() {}, error() {} },
    now: () => new Date("2026-07-12T19:00:00Z"), // Sunday noon Pacific
  });
  const res = await svc.rotateOnce({ dryRun: false });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "outside-business-hours");
  assert.equal(client.updates.length, 0);
});

test("withinBusinessHours: weekday midday yes; night and weekend no", () => {
  assert.equal(withinBusinessHours(new Date("2026-07-09T19:00:00Z")), true);  // Thu 12:00 PDT
  assert.equal(withinBusinessHours(new Date("2026-07-09T11:00:00Z")), false); // Thu 04:00 PDT
  assert.equal(withinBusinessHours(new Date("2026-07-12T19:00:00Z")), false); // Sunday
});
