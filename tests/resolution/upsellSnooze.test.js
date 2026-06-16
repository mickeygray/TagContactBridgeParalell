"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUpsellCheckAgainOn,
  isUpsellSuppressed,
} = require("../../packages/shared-repositories/src/clientProfileRepository");

const NOW = new Date("2026-06-16T12:00:00Z");
const DAY = 86_400_000;
const ENV_KEY = "RESOLUTION_UPSELL_SNOOZE_DAYS";

function withEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

// ── resolveUpsellCheckAgainOn ─────────────────────────────────────────────────
test("resolveUpsellCheckAgainOn: default snooze is +30 days", () => {
  withEnv(undefined, () => {
    assert.equal(resolveUpsellCheckAgainOn({ now: NOW }).getTime(), NOW.getTime() + 30 * DAY);
  });
});

test("resolveUpsellCheckAgainOn: explicit days override the default", () => {
  withEnv(undefined, () => {
    assert.equal(resolveUpsellCheckAgainOn({ now: NOW, days: 14 }).getTime(), NOW.getTime() + 14 * DAY);
  });
});

test("resolveUpsellCheckAgainOn: env knob overrides default when no days passed", () => {
  withEnv("7", () => {
    assert.equal(resolveUpsellCheckAgainOn({ now: NOW }).getTime(), NOW.getTime() + 7 * DAY);
  });
});

test("resolveUpsellCheckAgainOn: an explicit checkAgainOn date wins over days/env", () => {
  const explicit = new Date("2026-07-01T00:00:00Z");
  withEnv("7", () => {
    assert.equal(
      resolveUpsellCheckAgainOn({ now: NOW, checkAgainOn: explicit, days: 14 }).getTime(),
      explicit.getTime(),
    );
  });
});

test("resolveUpsellCheckAgainOn: unparseable explicit date returns null (caller can reject)", () => {
  assert.equal(resolveUpsellCheckAgainOn({ now: NOW, checkAgainOn: "not-a-date" }), null);
});

test("resolveUpsellCheckAgainOn: invalid/negative days fall back to the default", () => {
  withEnv(undefined, () => {
    assert.equal(resolveUpsellCheckAgainOn({ now: NOW, days: -5 }).getTime(), NOW.getTime() + 30 * DAY);
    assert.equal(resolveUpsellCheckAgainOn({ now: NOW, days: "nope" }).getTime(), NOW.getTime() + 30 * DAY);
  });
});

// ── isUpsellSuppressed ────────────────────────────────────────────────────────
test("isUpsellSuppressed: future checkAgainOn → suppressed", () => {
  assert.equal(isUpsellSuppressed({ upsell: { checkAgainOn: new Date(NOW.getTime() + DAY) } }, NOW), true);
});

test("isUpsellSuppressed: past checkAgainOn → not suppressed (eligible again)", () => {
  assert.equal(isUpsellSuppressed({ upsell: { checkAgainOn: new Date(NOW.getTime() - DAY) } }, NOW), false);
});

test("isUpsellSuppressed: missing upsell / checkAgainOn / null profile → not suppressed", () => {
  assert.equal(isUpsellSuppressed({}, NOW), false);
  assert.equal(isUpsellSuppressed({ upsell: {} }, NOW), false);
  assert.equal(isUpsellSuppressed(null, NOW), false);
});
