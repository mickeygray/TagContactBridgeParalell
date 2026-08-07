"use strict";

// THE SHARED HTTP CLIENT'S TIMEOUT — it did not cover the body.
//
// `requestJson` cleared its abort timer one line before `parseResponse`, and
// `response.text()` streams. A server that sent headers and then stalled the
// body left that await hanging FOREVER: no timeout, no retry, and the calling
// worker wedged. Every integration in the repo goes through this client, so the
// hang was available to Logics, RingCentral, CallRail and PhoneBurner alike.
//
// It was found as the root cause of a Jira claim hazard — a live-but-stalled
// webhook holder outliving its 10-minute claim lease, letting the drain take
// over and create a second un-deletable Logics task — but the defect is the
// client's, not that caller's.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { requestJson } = require("../../packages/shared-integrations/src/httpClient");

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(r)),
  }));
});

test("a stalled BODY aborts on the timeout instead of hanging forever", async () => {
  // Headers sent, Content-Length promised, body never finished — the exact
  // shape that used to hang. Before the fix this test never returns.
  const held = [];
  const s = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "99" });
    res.write('{"partial":');
    held.push(res); // deliberately never end()
  });
  try {
    const started = Date.now();
    await assert.rejects(
      () => requestJson(s.url, {}, { timeoutMs: 600, retries: 0 }),
      (error) => /abort/i.test(`${error.name} ${error.message}`),
      "a stalled body must surface as an abort, which the retry policy already handles",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `must abort near its timeout; took ${elapsed}ms`);
  } finally {
    for (const res of held) res.destroy();
    await s.close();
  }
});

test("the retry policy now covers a stalled body, not just a stalled connection", async () => {
  let attempts = 0;
  const held = [];
  const s = await listen((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "99" });
      res.write('{"partial":');
      held.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ recovered: true }));
  });
  try {
    const out = await requestJson(s.url, {}, { timeoutMs: 600, retries: 1 });
    assert.equal(attempts, 2, "the stalled body must have been retried");
    assert.deepEqual(out.data, { recovered: true });
  } finally {
    for (const res of held) res.destroy();
    await s.close();
  }
});

test("an ordinary response still succeeds, and its timer is disarmed", async () => {
  // The clear moved into a `finally`, so every exit path — return, continue,
  // throw — disarms it. A leaked timer would keep the process alive.
  const s = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: 1 }));
  });
  try {
    const out = await requestJson(s.url, {}, { timeoutMs: 5000, retries: 0 });
    assert.equal(out.ok, true);
    assert.deepEqual(out.data, { ok: 1 });
  } finally {
    await s.close();
  }
});

test("a slow but COMPLETING body inside the budget is not aborted", async () => {
  // The fix must not turn a merely-slow response into a failure.
  const s = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"slow"');
    setTimeout(() => res.end(":true}"), 250);
  });
  try {
    const out = await requestJson(s.url, {}, { timeoutMs: 3000, retries: 0 });
    assert.deepEqual(out.data, { slow: true });
  } finally {
    await s.close();
  }
});

test("an aborted POST is NEVER retried — a duplicate message beats no message", async () => {
  // Arming the timer through the body read made a stalled response abortable,
  // which is right — but it also made it CATCHABLE, and a caught abort on a
  // POST fell straight into the retry. The outcome of an aborted POST is
  // UNKNOWN: the provider may have accepted it and simply failed to finish
  // answering. sendgridClient (email) and callFireClient (sms/rvm) both POST
  // with retries: 1, so that retry was a duplicate message to a real person.
  let posts = 0;
  const held = [];
  const s = await listen((req, res) => {
    posts += 1;
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "99" });
    res.write('{"accepted":');
    held.push(res); // accepted, then the response stalls
  });
  try {
    await assert.rejects(
      () => requestJson(s.url, { method: "POST", body: "{}" }, { timeoutMs: 500, retries: 1 }),
      (error) => /abort/i.test(`${error.name} ${error.message}`),
    );
    assert.equal(posts, 1, "the message must be sent ONCE, never re-sent on an unknown outcome");
  } finally {
    for (const res of held) res.destroy();
    await s.close();
  }
});

test("an aborted GET still retries — re-reading is free", async () => {
  let gets = 0;
  const held = [];
  const s = await listen((req, res) => {
    gets += 1;
    if (gets === 1) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "99" });
      res.write('{"partial":');
      held.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const out = await requestJson(s.url, { method: "GET" }, { timeoutMs: 500, retries: 1 });
    assert.equal(gets, 2, "an idempotent read may be retried");
    assert.deepEqual(out.data, { ok: true });
  } finally {
    for (const res of held) res.destroy();
    await s.close();
  }
});
