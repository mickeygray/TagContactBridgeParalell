"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { requestJson } = require("../../packages/shared-integrations/src/httpClient");

test("shared HTTP transport preserves only Retry-After metadata needed for provider backpressure", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "retry-after" ? "17" : null;
      },
    },
    text: async () => JSON.stringify({ status: "error" }),
  });

  const response = await requestJson("https://provider.invalid/contact", {}, { retries: 0, timeoutMs: 1_000 });
  assert.deepEqual(response, {
    ok: false,
    status: 429,
    data: { status: "error" },
    headers: { "retry-after": "17" },
  });
});

