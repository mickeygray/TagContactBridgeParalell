"use strict";

const crypto = require("node:crypto");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function targetAudioKey({ schemaVersion = "1", provider, model, profileId, text }) {
  for (const [label, value] of Object.entries({ provider, model, profileId, text })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  }
  return `target-audio/${crypto.createHash("sha256").update(stableStringify({
    schemaVersion,
    provider: provider.trim(),
    model: model.trim(),
    profileId: profileId.trim(),
    text: text.trim(),
  })).digest("hex")}`;
}

function createTrainingTargetAudioCacheService({ storage, synthesize }) {
  if (!storage || typeof storage.get !== "function" || typeof storage.put !== "function") {
    throw new TypeError("target audio storage is required");
  }
  if (typeof synthesize !== "function") throw new TypeError("target audio synthesizer is required");

  async function ensureManifest({ manifestId, provider, model, profileId, lines }) {
    if (!Array.isArray(lines) || lines.length === 0) throw new TypeError("target audio lines are required");
    const entries = lines.map((line, index) => {
      const text = String(line?.text || "").trim();
      const lineId = String(line?.lineId || "").trim();
      if (!lineId || !text) throw new TypeError(`target audio line ${index} is invalid`);
      return { lineId, text, key: targetAudioKey({ provider, model, profileId, text }) };
    });
    if (new Set(entries.map((entry) => entry.lineId)).size !== entries.length) {
      throw new TypeError("target audio line IDs must be unique");
    }
    const staged = [];
    try {
      for (const entry of entries) {
        let artifact = await storage.get(entry.key);
        if (!artifact) {
          artifact = await synthesize({ provider, model, profileId, text: entry.text });
          if (!artifact) throw new Error("TARGET_AUDIO_SYNTHESIS_EMPTY");
          await storage.put(entry.key, artifact);
          staged.push(entry.key);
        }
      }
    } catch (error) {
      if (typeof storage.delete === "function") {
        await Promise.allSettled(staged.map((key) => storage.delete(key)));
      }
      const wrapped = new Error("TRAINER_TARGET_AUDIO_NOT_READY");
      wrapped.code = "TRAINER_TARGET_AUDIO_NOT_READY";
      wrapped.cause = error;
      throw wrapped;
    }
    return Object.freeze({
      manifestId,
      ready: true,
      provider,
      model,
      profileId,
      entries: Object.freeze(entries.map(({ lineId, key }) => Object.freeze({ lineId, key }))),
    });
  }

  async function assertReady(manifest) {
    if (!manifest?.ready || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      const error = new Error("TRAINER_TARGET_AUDIO_NOT_READY");
      error.code = "TRAINER_TARGET_AUDIO_NOT_READY";
      throw error;
    }
    const artifacts = await Promise.all(manifest.entries.map((entry) => storage.get(entry.key)));
    if (artifacts.some((artifact) => !artifact)) {
      const error = new Error("TRAINER_TARGET_AUDIO_NOT_READY");
      error.code = "TRAINER_TARGET_AUDIO_NOT_READY";
      throw error;
    }
    return artifacts;
  }
  return Object.freeze({ assertReady, ensureManifest });
}

module.exports = { createTrainingTargetAudioCacheService, targetAudioKey };
