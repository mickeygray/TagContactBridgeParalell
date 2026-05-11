"use strict";

const { SocialResponderConfig } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "TAG").trim().toUpperCase();
}

function normalizePlatform(platform) {
  return String(platform || "facebook").trim().toLowerCase();
}

function sanitizeKeywords(keywords = []) {
  return Array.from(
    new Set(
      (Array.isArray(keywords) ? keywords : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function normalizeActor(actor = null) {
  if (!actor) return { email: null, name: null };
  return {
    email: actor.email ? String(actor.email).trim().toLowerCase() : null,
    name: actor.name ? String(actor.name).trim() : null,
  };
}

async function findSocialResponderConfig(domain, platform) {
  return SocialResponderConfig.findOne({
    domain: normalizeDomain(domain),
    platform: normalizePlatform(platform),
  }).lean();
}

async function listSocialResponderConfigs(domain) {
  return SocialResponderConfig.find({
    domain: normalizeDomain(domain),
  })
    .sort({ platform: 1 })
    .lean();
}

async function upsertSocialResponderConfig(domain, platform, patch = {}, actor = null) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPlatform = normalizePlatform(platform);

  const nextSet = {
    enabled: Boolean(patch.enabled),
    triggerKeywords: sanitizeKeywords(patch.triggerKeywords),
    commentReplyTemplate: String(patch.commentReplyTemplate || "").trim(),
    directReplyTemplate: String(patch.directReplyTemplate || "").trim(),
    updatedBy: normalizeActor(actor),
  };

  return SocialResponderConfig.findOneAndUpdate(
    { domain: normalizedDomain, platform: normalizedPlatform },
    {
      $set: nextSet,
      $setOnInsert: {
        domain: normalizedDomain,
        platform: normalizedPlatform,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

async function recordSocialResponderEvent(domain, platform, details = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPlatform = normalizePlatform(platform);
  const now = new Date();
  const inc = { "stats.totalWebhookEvents": 1 };
  const set = {
    "stats.lastWebhookAt": now,
  };

  if (details.eventType) {
    set["stats.lastEventType"] = String(details.eventType);
  }
  if (details.senderId) {
    set["stats.lastSenderId"] = String(details.senderId);
  }
  if (details.keyword) {
    inc["stats.matchedEvents"] = 1;
    set["stats.lastMatchedAt"] = now;
    set["stats.lastKeyword"] = String(details.keyword).toLowerCase();
  }
  if (details.replied) {
    inc["stats.repliesSent"] = 1;
    set["stats.lastReplyAt"] = now;
  }
  if (details.error) {
    set["stats.lastError"] = String(details.error);
    set["stats.lastErrorAt"] = now;
  }

  return SocialResponderConfig.findOneAndUpdate(
    { domain: normalizedDomain, platform: normalizedPlatform },
    {
      $inc: inc,
      $set: set,
      $setOnInsert: {
        domain: normalizedDomain,
        platform: normalizedPlatform,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

module.exports = {
  findSocialResponderConfig,
  listSocialResponderConfigs,
  upsertSocialResponderConfig,
  recordSocialResponderEvent,
};
