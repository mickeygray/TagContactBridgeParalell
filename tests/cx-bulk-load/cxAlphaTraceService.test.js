"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  logCxAlpha,
  redactCxAlphaPayload,
  traceMatchesFilter,
} = require("../../packages/shared-services/src/cxAlphaTraceService");

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("alpha trace is default-off and does not call the logger", () => {
  return withEnv({ CX_ALPHA_TRACE_ENABLED: null }, () => {
    const calls = [];
    const logged = logCxAlpha("cx.alpha.test", { sessionId: "s1" }, {
      logger: { info: (...args) => calls.push(args) },
    });
    assert.equal(logged, false);
    assert.equal(calls.length, 0);
  });
});

test("alpha trace redacts sensitive values when enabled", () => {
  return withEnv({ CX_ALPHA_TRACE_ENABLED: "1", CX_ALPHA_TRACE_AGENT: null }, () => {
    const calls = [];
    const logged = logCxAlpha("cx.alpha.test", {
      agentEmail: "agent@example.test",
      phone: "555-123-6789",
      phoneLast4: "6789",
      rawTranscript: "private words",
      nested: { authorization: "Bearer secret" },
    }, {
      logger: { info: (...args) => calls.push(args) },
    });
    assert.equal(logged, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].agentEmail, "agent@example.test");
    assert.equal(calls[0][1].phone, "[redacted:last4:6789]");
    assert.equal(calls[0][1].phoneLast4, "6789");
    assert.equal(calls[0][1].rawTranscript, "[redacted]");
    assert.equal(calls[0][1].nested.authorization, "[redacted]");
  });
});

test("alpha trace catches logger failures and never throws", () => {
  return withEnv({ CX_ALPHA_TRACE_ENABLED: "true" }, () => {
    const logged = logCxAlpha("cx.alpha.test", { sessionId: "s1" }, {
      logger: {
        info: () => {
          throw new Error("logger down");
        },
      },
    });
    assert.equal(logged, false);
  });
});

test("alpha trace agent filter runs against preserved correlation fields", () => {
  return withEnv({ CX_ALPHA_TRACE_ENABLED: "1", CX_ALPHA_TRACE_AGENT: "sean" }, () => {
    const calls = [];
    const logged = logCxAlpha("cx.alpha.test", { agentEmail: "sean@example.test" }, {
      logger: { info: (...args) => calls.push(args) },
    });
    assert.equal(logged, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].agentEmail, "sean@example.test");
  });
});

test("alpha trace agent filter matches common correlation fields", () => {
  assert.equal(traceMatchesFilter({ agentEmail: "sean@example.test" }, { agentFilter: "sean" }), true);
  assert.equal(traceMatchesFilter({ sessionId: "bulk-session-1" }, { agentFilter: "bulk-session" }), true);
  assert.equal(traceMatchesFilter({ currentQueueItemId: "q123" }, { agentFilter: "q123" }), true);
  assert.equal(traceMatchesFilter({ agentEmail: "bruce@example.test" }, { agentFilter: "sean" }), false);
});

test("redact helper bounds arrays and depth", () => {
  const payload = redactCxAlphaPayload({
    phone: "5551239999",
    rows: Array.from({ length: 30 }, (_, index) => ({ index })),
    nested: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
  });
  assert.equal(payload.phone, "[redacted:last4:9999]");
  assert.equal(payload.rows.length, 25);
  assert.equal(payload.nested.a.b.c.d.e, "[redacted:depth]");
});
