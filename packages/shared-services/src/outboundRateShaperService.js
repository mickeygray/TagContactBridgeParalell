"use strict";

const { getSharedConfig } = require("../../shared-config/src");

const bucketState = new Map();

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase();
}

function toDate(value) {
  const next = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(next.getTime()) ? new Date() : next;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function getWindowMs(windowMinutes) {
  return Math.max(Number(windowMinutes) || 15, 1) * 60 * 1000;
}

function buildBucketKey(domain, channel) {
  return `${normalizeDomain(domain)}:${normalizeChannel(channel)}`;
}

function cleanupBuckets(now = new Date(), windowMs = getWindowMs(15)) {
  for (const [key, entry] of bucketState.entries()) {
    if (!entry?.lastRefillAt) {
      bucketState.delete(key);
      continue;
    }
    if (now.getTime() - entry.lastRefillAt.getTime() > windowMs * 4) {
      bucketState.delete(key);
    }
  }
}

function resolveRateShaperChannelConfig(channel, config = null) {
  const shared = config || getSharedConfig();
  const rateShaper = shared.outboundRateShaper || {};
  const normalizedChannel = normalizeChannel(channel);
  const channelConfig = rateShaper.channels?.[normalizedChannel] || null;
  if (!channelConfig) return null;
  return {
    enabled: Boolean(rateShaper.enabled) && Boolean(channelConfig.enabled),
    windowMinutes: clampNumber(rateShaper.windowMinutes, 1, 60),
    baseTokens: clampNumber(channelConfig.baseTokens, 1, 5000),
    maxTokens: clampNumber(
      channelConfig.maxTokens != null ? channelConfig.maxTokens : channelConfig.baseTokens,
      1,
      10000,
    ),
    queueStep: clampNumber(channelConfig.queueStep, 1, 10000),
    tokensPerStep: clampNumber(channelConfig.tokensPerStep, 0, 5000),
  };
}

function computeBucketCapacity(channelConfig, queueDepth = 1) {
  const normalizedDepth = Math.max(Number(queueDepth) || 1, 1);
  const extraSteps = Math.floor(Math.max(normalizedDepth - 1, 0) / channelConfig.queueStep);
  const boosted =
    channelConfig.baseTokens + extraSteps * channelConfig.tokensPerStep;
  return clampNumber(boosted, 1, channelConfig.maxTokens);
}

function refillBucket(entry, capacity, now, windowMs) {
  const previousTokens = Number(entry?.tokens);
  const lastRefillAt = toDate(entry?.lastRefillAt || now);
  const elapsedMs = Math.max(now.getTime() - lastRefillAt.getTime(), 0);
  const refillPerMs = capacity / windowMs;
  const tokens = Math.min(
    capacity,
    (Number.isFinite(previousTokens) ? previousTokens : capacity) + elapsedMs * refillPerMs,
  );
  return {
    tokens,
    lastRefillAt: now,
  };
}

function evaluateOutboundRateLimit({
  domain,
  channel,
  now = new Date(),
  queueDepth = 1,
  config = null,
  consume = true,
} = {}) {
  const channelConfig = resolveRateShaperChannelConfig(channel, config);
  if (!channelConfig?.enabled) {
    return {
      enabled: false,
      allowed: true,
      reason: "rate-shaper-disabled",
      queueDepth: Math.max(Number(queueDepth) || 1, 1),
      channel: normalizeChannel(channel),
      domain: normalizeDomain(domain),
    };
  }

  const normalizedNow = toDate(now);
  const normalizedDomain = normalizeDomain(domain);
  const normalizedChannel = normalizeChannel(channel);
  const normalizedDepth = Math.max(Number(queueDepth) || 1, 1);
  const windowMs = getWindowMs(channelConfig.windowMinutes);
  const capacity = computeBucketCapacity(channelConfig, normalizedDepth);
  const key = buildBucketKey(normalizedDomain, normalizedChannel);
  const current = bucketState.get(key) || null;
  const refilled = refillBucket(current, capacity, normalizedNow, windowMs);

  let nextState = {
    capacity,
    tokens: refilled.tokens,
    lastRefillAt: refilled.lastRefillAt,
  };

  const allowed = refilled.tokens >= 1;
  let nextAllowedAt = null;
  if (allowed && consume) {
    nextState.tokens = Math.max(refilled.tokens - 1, 0);
  } else {
    if (!allowed) {
      const deficit = 1 - refilled.tokens;
      const refillPerMs = capacity / windowMs;
      const waitMs = Math.ceil(deficit / Math.max(refillPerMs, 0.000001));
      nextAllowedAt = new Date(normalizedNow.getTime() + waitMs);
    }
  }

  if (consume) {
    bucketState.set(key, nextState);
  }
  cleanupBuckets(normalizedNow, windowMs);

  return {
    enabled: true,
    allowed,
    reason: allowed
      ? consume
        ? "rate-shaper-allowed"
        : "rate-shaper-preview-allowed"
      : "rate-shaper-throttled",
    domain: normalizedDomain,
    channel: normalizedChannel,
    queueDepth: normalizedDepth,
    capacity,
    remainingTokens: Number((consume ? nextState.tokens : refilled.tokens).toFixed(3)),
    nextAllowedAt,
    windowMinutes: channelConfig.windowMinutes,
    consumed: Boolean(consume && allowed),
  };
}

function resetOutboundRateShaper() {
  bucketState.clear();
}

module.exports = {
  evaluateOutboundRateLimit,
  resetOutboundRateShaper,
  resolveRateShaperChannelConfig,
};
