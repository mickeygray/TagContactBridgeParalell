"use strict";

// TRANSPORT PINS (2026-07-08) — the solo transport shipped with ZERO tests (audit F4
// noted it); the two-station transports do not. The two pins that MUST hold forever:
// truncation is failure (A2), and rate limits surface retryAfterMs for the cooldown.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createTwoStationTransports } = require("../../apps/ai-bus/src/coachTwoStationTransports");

const silent = { info: () => {}, warn: () => {} };

function fakeFetch(response) {
  return async () => response;
}
function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("dormant without a key: both runners null (loop idles)", () => {
  const t = createTwoStationTransports({ logger: silent, env: {}, fetchImpl: fakeFetch({}) });
  assert.equal(t.runStrategist, null);
  assert.equal(t.runCoach, null);
});

test("happy path: text joined, usage + model returned, stations use their own models", async () => {
  let sentBody = null;
  const t = createTwoStationTransports({
    logger: silent,
    env: { LIVE_COACH_SOLO_ANTHROPIC_API_KEY: "k" },
    fetchImpl: async (url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse({
        content: [{ type: "text", text: '{"say":"hi"}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: sentBody.model,
        stop_reason: "end_turn",
      });
    },
  });
  const res = await t.runCoach({ system: "S", prompt: "P" });
  assert.equal(res.ok, true);
  assert.equal(res.text, '{"say":"hi"}');
  assert.equal(res.usage.input_tokens, 10);
  assert.match(sentBody.model, /haiku/);
  assert.equal(sentBody.system[0].cache_control.type, "ephemeral");
  await t.runStrategist({ system: "S", prompt: "P" });
  assert.match(sentBody.model, /sonnet/);
});

test("TRUNCATION IS FAILURE (audit A2): stop_reason max_tokens -> ok:false, never a parse attempt", async () => {
  const t = createTwoStationTransports({
    logger: silent,
    env: { LIVE_COACH_SOLO_ANTHROPIC_API_KEY: "k" },
    fetchImpl: fakeFetch(jsonResponse({
      content: [{ type: "text", text: '{"guidance":[{"currentSect' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 2500 },
    })),
  });
  const res = await t.runStrategist({ system: "S", prompt: "P" });
  assert.equal(res.ok, false);
  assert.match(res.error, /truncated:max_tokens/);
});

test("429 surfaces retryAfterMs honoring Retry-After with a 30s floor", async () => {
  const t = createTwoStationTransports({
    logger: silent,
    env: { LIVE_COACH_SOLO_ANTHROPIC_API_KEY: "k" },
    fetchImpl: fakeFetch(jsonResponse({}, { status: 429, headers: { "retry-after": "45" } })),
  });
  const res = await t.runCoach({ system: "S", prompt: "P" });
  assert.equal(res.ok, false);
  assert.equal(res.retryAfterMs, 45_000);
  // floor: a 429 with no header still cools 30s
  const t2 = createTwoStationTransports({
    logger: silent,
    env: { LIVE_COACH_SOLO_ANTHROPIC_API_KEY: "k" },
    fetchImpl: fakeFetch(jsonResponse({}, { status: 429 })),
  });
  const res2 = await t2.runCoach({ system: "S", prompt: "P" });
  assert.equal(res2.retryAfterMs, 30_000);
});

test("non-rate-limit HTTP errors fail plainly with no retry hint", async () => {
  const t = createTwoStationTransports({
    logger: silent,
    env: { LIVE_COACH_SOLO_ANTHROPIC_API_KEY: "k" },
    fetchImpl: fakeFetch(jsonResponse({}, { status: 500 })),
  });
  const res = await t.runStrategist({ system: "S", prompt: "P" });
  assert.equal(res.ok, false);
  assert.equal(res.retryAfterMs, 0);
});
