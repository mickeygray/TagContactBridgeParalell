"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAiTaskClient } = require("../../packages/shared-services/src/aiTaskClient");
const { runTask, listTasks, getTaskInfo } = require("../../apps/ai-bus/src/aiTaskRoutes");

// ── client: success + the timing breakdown (transport = roundTrip - bus) ──────
test("client returns the envelope and derives transportMs = roundTrip - busMs", async () => {
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, taskId: "ai.read", provider: "anthropic", result: { topic: "levy" }, timing: { busMs: 10 } }),
    });
  };
  let i = 0;
  const now = () => [100, 112][i++]; // startedAt, after
  const { runAiTask } = createAiTaskClient({ baseUrl: "http://bus", secret: "S", fetchImpl: fakeFetch, now });

  const r = await runAiTask("ai.read", { input: "x" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { topic: "levy" });
  assert.equal(r.timing.roundTripMs, 12);
  assert.equal(r.timing.busMs, 10);
  assert.equal(r.timing.transportMs, 2, "transport = 12 - 10");
  // routed to the right place with the right secret + body
  assert.equal(calls[0].url, "http://bus/api/ai/tasks/ai.read/run");
  assert.equal(calls[0].opts.headers["x-service-secret"], "S");
  assert.equal(JSON.parse(calls[0].opts.body).payload.input, "x");
});

test("client omits the secret header when none is configured", async () => {
  let seen = null;
  const fakeFetch = (url, opts) => {
    seen = opts.headers;
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, timing: { busMs: 1 } }) });
  };
  await createAiTaskClient({ baseUrl: "http://bus", secret: "", fetchImpl: fakeFetch, now: () => 0 }).runAiTask("ai.read", {});
  assert.equal("x-service-secret" in seen, false);
});

// ── client: transport failures fail closed (bus never crashes the caller) ────
test("client transport error fails closed with the caller's safeFallback", async () => {
  const fakeFetch = () => Promise.reject(new Error("ECONNREFUSED"));
  const r = await createAiTaskClient({ baseUrl: "http://bus", fetchImpl: fakeFetch, now: () => 0 }).runAiTask("sms.classify", {}, { safeFallback: { tier: "needs_human" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "transport_error");
  assert.deepEqual(r.safeFallback, { tier: "needs_human" });
  assert.equal(r.timing.busMs, null);
});

test("client maps an aborted request to transport_timeout", async () => {
  const fakeFetch = () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    return Promise.reject(e);
  };
  const r = await createAiTaskClient({ baseUrl: "http://bus", fetchImpl: fakeFetch, now: () => 0 }).runAiTask("ai.read", {});
  assert.equal(r.code, "transport_timeout");
});

test("client maps a non-2xx bus response to bus_http_<status>", async () => {
  const fakeFetch = () => Promise.resolve({ ok: false, status: 500, text: async () => "" });
  const r = await createAiTaskClient({ baseUrl: "http://bus", fetchImpl: fakeFetch, now: () => 0 }).runAiTask("ai.read", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "bus_http_500");
});

// ── routes: the run handler stamps busMs; catalog handlers shape correctly ───
test("runTask handler stamps busMs into the envelope", async () => {
  let j = 0;
  const now = () => [0, 5][j++];
  const runner = { runAiTask: async () => ({ ok: true, result: 1, timing: {} }) };
  const r = await runTask(runner, "ai.read", { payload: {} }, now);
  assert.equal(r.status, 200);
  assert.equal(r.json.timing.busMs, 5);
});

test("catalog handlers list + 404 cleanly", () => {
  const reg = { listTasks: () => [{ id: "a" }], describeTask: (t) => ({ id: t.id }), getTask: (id) => (id === "a" ? { id: "a" } : null) };
  assert.deepEqual(listTasks(reg).json, { ok: true, tasks: [{ id: "a" }] });
  assert.equal(getTaskInfo(reg, "a").status, 200);
  assert.equal(getTaskInfo(reg, "nope").status, 404);
});
