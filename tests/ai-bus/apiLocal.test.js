"use strict";

// THE VERIFICATION LAYER — the API on local.
// A real HTTP server (Node http, no deps) wrapping the runner, exercised over the
// wire: shapes IN over POST, the envelope OUT as JSON. This pins the route
// contract for POST /api/ai/tasks/:taskId/run and GET /api/ai/tasks so that
// writing the real 7000 routes = satisfying these.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { buildSandboxRunner } = require("./sandboxHarness");
const sandbox = require("../../packages/shared-services/src/aiSandbox");

// The minimal route surface the real 7000 routes must implement.
function makeApi(runner) {
  return http.createServer((req, res) => {
    const runMatch = req.url.match(/^\/api\/ai\/tasks\/(.+)\/run$/);
    if (req.method === "POST" && runMatch) {
      const taskId = decodeURIComponent(runMatch[1]);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          /* keep parsed = {} */
        }
        const out = await runner.runAiTask(taskId, parsed.payload || {}, parsed.options || {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/ai/tasks") {
      // read-only catalog — MUST NOT leak prompt bodies or secrets
      const tasks = sandbox.listSandboxTasks().map((t) => ({
        id: t.id,
        kind: t.kind,
        provider: t.provider,
        hasSchema: Boolean(t.schema),
        cached: Boolean(t.cache),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, tasks }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withApi(result, fn) {
  const { runner } = buildSandboxRunner({ result });
  const server = makeApi(runner);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── POST run: shape in → envelope out ────────────────────────────────────────
test("API POST /run: valid result returns the ok envelope", async () => {
  await withApi(() => ({ json: { status: "stop_contact", confidence: "high" } }), async (port) => {
    const res = await request(port, "POST", "/api/ai/tasks/activity.contactSafetyReview/run", {
      payload: { domain: "TAG", caseId: 1, activities: [{ Comment: "cease and desist" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.taskId, "activity.contactSafetyReview");
    assert.equal(res.json.provider, "anthropic");
    assert.equal(res.json.result.status, "stop_contact");
  });
});

test("API POST /run: compliance fail-closed shape comes back over the wire", async () => {
  await withApi(() => ({ json: {} }), async (port) => {
    const res = await request(port, "POST", "/api/ai/tasks/sms.classify/run", { payload: { input: "stop texting me" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.deepEqual(res.json.safeFallback, { tier: "needs_human", confidence: 0, viaFailClosed: true });
  });
});

test("API POST /run: unknown task is a clean envelope, not a 500", async () => {
  await withApi(() => ({ text: "x" }), async (port) => {
    const res = await request(port, "POST", "/api/ai/tasks/nope.nope/run", { payload: {} });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, "unknown_task");
  });
});

test("API POST /run: forceProvider routes over the wire", async () => {
  await withApi((p) => ({ text: `from-${p}`, model: "m" }), async (port) => {
    const res = await request(port, "POST", "/api/ai/tasks/resolution.pitch/run", {
      payload: { input: "{}" },
      options: { forceProvider: "openai" },
    });
    assert.equal(res.json.ok, true);
    assert.equal(res.json.provider, "openai");
    assert.equal(res.json.result, "from-openai");
  });
});

// ── GET catalog: lists tasks, leaks no prompt bodies ─────────────────────────
test("API GET /api/ai/tasks: lists tasks without leaking prompts", async () => {
  await withApi(() => ({ text: "x" }), async (port) => {
    const res = await request(port, "GET", "/api/ai/tasks");
    assert.equal(res.json.ok, true);
    assert.ok(res.json.tasks.length >= 20);
    const activity = res.json.tasks.find((t) => t.id === "activity.contactSafetyReview");
    assert.ok(activity);
    assert.equal(activity.hasSchema, true);
    // no prompt/system field anywhere in the catalog payload
    assert.equal(JSON.stringify(res.json).includes("Wynn Tax Solutions"), false, "catalog must not leak prompt text");
  });
});
