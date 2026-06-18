"use strict";

// Boot-and-serve test for the local synthetic bus — the failable check that we
// can boot locally and push real-shaped (synthetic) data over the real HTTP path.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startLocalBus } = require("../../apps/ai-bus/src/localBusServer");

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

test("local synthetic bus boots and serves synthetic data over HTTP", async () => {
  const server = startLocalBus({ port: 0 });
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const port = server.address().port;
  try {
    const idx = await request(port, "GET", "/");
    assert.equal(idx.json.ok, true);
    assert.equal(idx.json.bus, "local-synthetic");

    // a compose primitive returns synthetic prose
    const write = await request(port, "POST", "/api/ai/tasks/ai.write/run", { payload: { prompt: "Draft an intro about IRS levies." } });
    assert.equal(write.json.ok, true);
    assert.ok(typeof write.json.result === "string" && write.json.result.length > 10);
    assert.match(write.json.model, /synthetic/); // provider = slot ("anthropic"); synthetic marker is in the model
    assert.equal(typeof write.json.timing.busMs, "number");

    // a sandbox-backed NAMED task returns schema-shaped synthetic json (real contract)
    const review = await request(port, "POST", "/api/ai/tasks/activity.contactSafetyReview/run", {
      payload: { domain: "TAG", caseId: 1, activities: [{ Comment: "cease and desist" }] },
    });
    assert.equal(review.json.ok, true, JSON.stringify(review.json));
    assert.ok(["allow_contact", "pause_contact", "stop_contact", "manual_review"].includes(review.json.result.status));
    assert.ok(["low", "medium", "high"].includes(review.json.result.confidence));

    // the catalog lists tasks and leaks no prompt text
    const catalog = await request(port, "GET", "/api/ai/tasks");
    assert.equal(catalog.json.ok, true);
    assert.ok(catalog.json.tasks.length >= 7);
    assert.equal(JSON.stringify(catalog.json).includes("Wynn Tax Solutions"), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
