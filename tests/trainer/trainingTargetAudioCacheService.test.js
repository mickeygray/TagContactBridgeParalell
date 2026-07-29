"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createTrainingTargetAudioCacheService,
  targetAudioKey,
} = require("../../packages/shared-services/src/trainingTargetAudioCacheService");

test("target audio keys bind provider, model, profile, schema, and normalized text", () => {
  const input = { provider: "openai", model: "tts-1", profileId: "tts_profile" };
  assert.equal(targetAudioKey({ ...input, text: " Hello " }), targetAudioKey({ ...input, text: "Hello" }));
  assert.notEqual(targetAudioKey({ ...input, text: "Hello" }), targetAudioKey({ ...input, model: "tts-2", text: "Hello" }));
});

test("target audio readiness is all-or-nothing and removes partial staged audio", async () => {
  const values = new Map();
  const deleted = [];
  let calls = 0;
  const service = createTrainingTargetAudioCacheService({
    storage: {
      get: async (key) => values.get(key) || null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => { deleted.push(key); values.delete(key); },
    },
    synthesize: async () => {
      calls += 1;
      if (calls === 2) throw new Error("provider down");
      return Buffer.from("audio");
    },
  });
  await assert.rejects(service.ensureManifest({
    manifestId: "fixture-manifest",
    provider: "fixture",
    model: "fixture-v1",
    profileId: "fixture-profile",
    lines: [{ lineId: "one", text: "First" }, { lineId: "two", text: "Second" }],
  }), { code: "TRAINER_TARGET_AUDIO_NOT_READY" });
  assert.equal(values.size, 0);
  assert.equal(deleted.length, 1);
});

test("complete cached manifests pass readiness without re-synthesis", async () => {
  const values = new Map();
  let calls = 0;
  const service = createTrainingTargetAudioCacheService({
    storage: {
      get: async (key) => values.get(key) || null,
      put: async (key, value) => values.set(key, value),
    },
    synthesize: async () => { calls += 1; return Buffer.from("audio"); },
  });
  const input = {
    manifestId: "fixture-manifest",
    provider: "fixture",
    model: "fixture-v1",
    profileId: "fixture-profile",
    lines: [{ lineId: "one", text: "First" }],
  };
  const manifest = await service.ensureManifest(input);
  await service.ensureManifest(input);
  assert.equal(calls, 1);
  assert.equal((await service.assertReady(manifest)).length, 1);
});
