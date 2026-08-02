"use strict";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5_000;

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeHash(value) {
  return String(value || "").trim().toLowerCase();
}

function createPrePingMemoryStore(options = {}) {
  const ttlMs = Math.max(Number(options.ttlMs) || DEFAULT_TTL_MS, 1_000);
  const maxEntries = Math.max(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES, 1);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const entries = new Map();

  function keyFor(domain, emailHash) {
    const normalizedDomain = normalizeDomain(domain);
    const normalizedHash = normalizeHash(emailHash);
    return normalizedDomain && normalizedHash
      ? `${normalizedDomain}:${normalizedHash}`
      : null;
  }

  function pruneExpired(at = now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  }

  function enforceLimit() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey == null) break;
      entries.delete(oldestKey);
    }
  }

  async function upsertPrePing(domain, emailHash, callbackUrl = null) {
    const key = keyFor(domain, emailHash);
    if (!key) return null;
    const at = now();
    pruneExpired(at);
    // Reinsert so the Map's insertion order is also the eviction order.
    entries.delete(key);
    const entry = {
      domain: normalizeDomain(domain),
      emailHash: normalizeHash(emailHash),
      callbackUrl: callbackUrl || null,
      createdAt: new Date(at),
      expiresAt: at + ttlMs,
    };
    entries.set(key, entry);
    enforceLimit();
    return { ...entry };
  }

  async function findPrePing(domain, emailHash) {
    const key = keyFor(domain, emailHash);
    if (!key) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return { ...entry };
  }

  async function consumePrePing(domain, emailHash) {
    const entry = await findPrePing(domain, emailHash);
    const key = keyFor(domain, emailHash);
    if (key) entries.delete(key);
    return entry;
  }

  function safeStats() {
    pruneExpired();
    return { size: entries.size, maxEntries, ttlMs };
  }

  return {
    consumePrePing,
    findPrePing,
    safeStats,
    upsertPrePing,
  };
}

module.exports = {
  createPrePingMemoryStore,
};
