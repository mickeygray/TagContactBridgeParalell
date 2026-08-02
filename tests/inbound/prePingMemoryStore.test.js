"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createPrePingMemoryStore } = require("../../apps/inbound-gateway/src/prePingMemoryStore");
const { leadCadenceRepository } = require("../../packages/shared-repositories/src");
const { intakeLdPrePing } = require("../../packages/shared-services/src/inboundIntakeService");

test("pre-ping correlation stays process-local and is consumed once", async () => {
  let now = Date.parse("2026-08-02T19:00:00.000Z");
  const store = createPrePingMemoryStore({ now: () => now });

  await store.upsertPrePing("wynn", "ABC123", "https://example.invalid/callback");
  const found = await store.findPrePing("WYNN", "abc123");
  assert.equal(found.domain, "WYNN");
  assert.equal(found.emailHash, "abc123");
  assert.equal(found.callbackUrl, "https://example.invalid/callback");

  assert.ok(await store.consumePrePing("WYNN", "abc123"));
  assert.equal(await store.findPrePing("WYNN", "abc123"), null);
});

test("pre-ping correlation expires after five minutes", async () => {
  let now = Date.parse("2026-08-02T19:00:00.000Z");
  const store = createPrePingMemoryStore({ now: () => now });
  await store.upsertPrePing("WYNN", "one");

  now += (5 * 60 * 1000) - 1;
  assert.ok(await store.findPrePing("WYNN", "one"));
  now += 1;
  assert.equal(await store.findPrePing("WYNN", "one"), null);
});

test("pre-ping correlation is bounded and refreshes recent entries", async () => {
  let now = Date.parse("2026-08-02T19:00:00.000Z");
  const store = createPrePingMemoryStore({ maxEntries: 2, now: () => now });
  await store.upsertPrePing("WYNN", "one");
  now += 1;
  await store.upsertPrePing("WYNN", "two");
  now += 1;
  await store.upsertPrePing("WYNN", "one");
  now += 1;
  await store.upsertPrePing("WYNN", "three");

  assert.ok(await store.findPrePing("WYNN", "one"));
  assert.equal(await store.findPrePing("WYNN", "two"), null);
  assert.ok(await store.findPrePing("WYNN", "three"));
  assert.deepEqual(store.safeStats(), {
    size: 2,
    maxEntries: 2,
    ttlMs: 5 * 60 * 1000,
  });
});

test("LD pre-ping accepts an injected transient store instead of Mongo persistence", async () => {
  const originalFind = leadCadenceRepository.findLeadCadenceByEmailHash;
  const calls = [];
  leadCadenceRepository.findLeadCadenceByEmailHash = async () => null;
  try {
    const result = await intakeLdPrePing(
      {
        "Date Of Birth": "1980-01-01",
        email_hash: "ABC123",
        callback_url: "https://example.invalid/callback",
      },
      {
        prePingStore: {
          async upsertPrePing(...args) {
            calls.push(args);
          },
        },
      },
    );

    assert.equal(result.accepted, true);
    assert.deepEqual(calls, [[
      "WYNN",
      crypto.createHash("md5").update("abc123").digest("hex"),
      "https://example.invalid/callback",
    ]]);
  } finally {
    leadCadenceRepository.findLeadCadenceByEmailHash = originalFind;
  }
});
