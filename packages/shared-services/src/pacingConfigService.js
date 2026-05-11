"use strict";

const { pacingConfigRepository } = require("../../shared-repositories/src");

// pacingConfigService — thin layer over pacingConfigRepository with an
// in-process cache (~30s TTL) so the queue services can read on every
// tick without slamming Mongo. Cache busts on any update; admin updates
// fire `bumpCacheVersion()` to force a re-read.

const CACHE_TTL_MS = 30_000;

let cached = null;
let cachedAt = 0;
let cacheVersion = 0;

async function getConfig({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && (now - cachedAt) < CACHE_TTL_MS) {
    return cached;
  }
  cached = await pacingConfigRepository.readConfig();
  cachedAt = now;
  return cached;
}

async function updateConfig(patch, { updatedBy = "system" } = {}) {
  const updated = await pacingConfigRepository.updateConfig(patch, { updatedBy });
  cached = updated;
  cachedAt = Date.now();
  cacheVersion += 1;
  return updated;
}

function bumpCacheVersion() {
  cacheVersion += 1;
  cached = null;
  cachedAt = 0;
}

function getCacheVersion() {
  return cacheVersion;
}

async function getHistory(opts) {
  return pacingConfigRepository.getHistory(opts);
}

// Validation — admin endpoints call this before persisting.
// Returns { ok: true } or { ok: false, errors: [...] }.
function validatePatch(patch = {}) {
  const errors = [];
  const checkInt = (key, min, max) => {
    if (key in patch) {
      const v = Number(patch[key]);
      if (!Number.isFinite(v) || v < min || v > max || !Number.isInteger(v)) {
        errors.push(`${key} must be integer in [${min}, ${max}]`);
      }
    }
  };
  checkInt("perAgentSliceSize", 1, 200);
  checkInt("teamHourlyTarget", 1, 10000);
  checkInt("freshLeadTimerSeconds", 10, 3600);
  checkInt("unavailReaperMinutes", 1, 240);
  checkInt("businessHoursStart", 0, 23);
  checkInt("businessHoursEnd", 1, 24);
  checkInt("agentLoginStartHour", 0, 23);
  checkInt("agentLoginEndHour", 1, 24);
  if ("businessHoursStart" in patch && "businessHoursEnd" in patch) {
    if (patch.businessHoursEnd <= patch.businessHoursStart) {
      errors.push("businessHoursEnd must be > businessHoursStart");
    }
  }
  if ("agentLoginStartHour" in patch && "agentLoginEndHour" in patch) {
    if (patch.agentLoginEndHour <= patch.agentLoginStartHour) {
      errors.push("agentLoginEndHour must be > agentLoginStartHour");
    }
  }
  if ("businessDays" in patch) {
    const d = patch.businessDays;
    if (!Array.isArray(d) || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
      errors.push("businessDays must be array of integers 0-6");
    }
  }
  if ("agentLoginDays" in patch) {
    const d = patch.agentLoginDays;
    if (!Array.isArray(d) || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
      errors.push("agentLoginDays must be array of integers 0-6");
    }
  }
  if ("holidays" in patch) {
    const h = patch.holidays;
    if (!Array.isArray(h) || h.some((x) => typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x))) {
      errors.push("holidays must be array of YYYY-MM-DD strings");
    }
  }
  if ("businessHoursTimezone" in patch) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: patch.businessHoursTimezone });
    } catch {
      errors.push("businessHoursTimezone must be a valid IANA timezone");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = {
  getConfig,
  updateConfig,
  getHistory,
  validatePatch,
  bumpCacheVersion,
  getCacheVersion,
};
