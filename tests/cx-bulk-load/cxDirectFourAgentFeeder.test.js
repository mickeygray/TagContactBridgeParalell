"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENTS,
  blockedCadence,
  distributeRoundRobin,
  externId,
  normalizePhone,
  parseArgs,
  resolveRoutes,
  rowsFromSearch,
  selectionQuery,
} = require("../../scripts/cx-direct-four-agent-feeder");

test("round robin preserves the active Chris, Brad, Sean order", () => {
  const rows = Array.from({ length: 10 }, (_, id) => ({ id }));
  const groups = distributeRoundRobin(rows, AGENTS);
  assert.deepEqual(groups.map((g) => g.route.key), ["chris", "brad", "sean"]);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => r.id)), [[0, 3, 6, 9], [1, 4, 7], [2, 5, 8]]);
});

test("stable extern IDs dedupe retries without tying a lead to an app queue row", () => {
  assert.equal(externId("WYNN", 12345), "cx-direct-wynn-12345");
  assert.equal(externId("WYNN", 12345), externId("WYNN", 12345));
});

test("phone and cadence guards reject unusable contact rows", () => {
  assert.equal(normalizePhone("+1 (310) 555-1212"), "3105551212");
  assert.equal(normalizePhone("555"), "");
  assert.equal(blockedCadence({ active: true, currentStage: "new" }), false);
  assert.equal(blockedCadence({ active: true, currentStage: "DNC" }), true);
  assert.equal(blockedCadence({ active: true, cadenceState: { channelDnc: { cx: { blocked: true } } } }), true);
});

test("incremental query is bounded by the initial cutoff", () => {
  const cutoff = new Date("2026-07-10T12:00:00Z");
  assert.deepEqual(selectionQuery("WYNN", "incremental", cutoff).createdAt, { $gt: cutoff });
  assert.equal(selectionQuery("WYNN", "initial", cutoff).createdAt, undefined);
  assert.deepEqual(selectionQuery("WYNN", "resume", cutoff).createdAt, { $lte: cutoff });
});

test("RingCX reconciliation accepts only explicit search results", () => {
  assert.deepEqual(rowsFromSearch({ records: [{ externId: "a" }] }), [{ externId: "a" }]);
  assert.throws(() => rowsFromSearch({ ok: true }), /unexpected response/);
});

test("apply is explicit and every route must be configured", () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(["--apply", "--mode", "incremental"]).apply, true);
  assert.throws(() => resolveRoutes({}), /Missing RingCX/);
  const env = {};
  const firstContactMap = {};
  for (const agent of AGENTS) {
    const token = agent.email.toUpperCase().replace(/@/g, "_AT_").replace(/[^A-Z0-9]/g, "_");
    env[`RINGCX_AGENT_ROUTE_${token}_CAMPAIGN_ID`] = `campaign-${agent.key}`;
    env[`RINGCX_AGENT_ROUTE_${token}_DIAL_GROUP_ID`] = `group-${agent.key}`;
    firstContactMap[agent.email] = `first-${agent.key}`;
  }
  env.CX_FIRST_TOUCH_QUEUE_MAP = JSON.stringify(firstContactMap);
  assert.deepEqual(resolveRoutes(env).map((route) => route.key), ["chris", "brad", "sean"]);
  assert.deepEqual(resolveRoutes(env, "incremental").map((route) => route.campaignId), ["first-chris", "first-brad", "first-sean"]);
  delete firstContactMap[AGENTS[2].email];
  env.CX_FIRST_TOUCH_QUEUE_MAP = JSON.stringify(firstContactMap);
  assert.throws(() => resolveRoutes(env, "incremental"), /Missing First Contact campaign route for sean/);
});
