"use strict";

/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Enough for OTP brute-force protection on /api/auth/* without pulling in an
 * external dependency. One process = one bucket store; acceptable because
 * auth traffic is low volume and the control-plane usually runs as a single
 * NSSM service. If we ever horizontally scale, swap for a Mongo-backed or
 * Redis-backed implementation.
 *
 * buckets key = `${keyFn(req)}:${minuteBucket}`; oldest entries are evicted
 * whenever the store grows past `maxEntries`.
 */
function createRateLimiter({
  windowMs = 60_000,
  max = 10,
  keyFn = (req) => req.ip || "unknown",
  maxEntries = 10_000,
  message = "Too many requests",
} = {}) {
  const store = new Map();

  function keep(bucketKey, entry) {
    store.set(bucketKey, entry);
    if (store.size > maxEntries) {
      // Evict ~10% oldest entries by insertion order.
      const evictCount = Math.ceil(maxEntries * 0.1);
      let removed = 0;
      for (const key of store.keys()) {
        store.delete(key);
        removed += 1;
        if (removed >= evictCount) break;
      }
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const bucketKey = `${keyFn(req)}:${windowStart}`;
    const entry = store.get(bucketKey) || { count: 0, firstAt: now };
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowStart + windowMs - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSeconds: retryAfter,
      });
    }

    keep(bucketKey, entry);
    return next();
  };
}

module.exports = { createRateLimiter };
