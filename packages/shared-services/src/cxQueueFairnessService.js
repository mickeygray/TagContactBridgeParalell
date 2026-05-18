"use strict";

const { normalizeLeadQueueFamily } = require("../../shared-normalizers/src");

const QUEUE_TIMEZONE = "America/Los_Angeles";

function readBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(value, 0);
}

function getPacificHourParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUEUE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getPacificHourKey(date = new Date()) {
  const parts = getPacificHourParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function getNextPacificHourBoundary(date = new Date()) {
  const parts = getPacificHourParts(date);
  const remainingSeconds = ((60 - parts.minute) * 60) - parts.second;
  return new Date(new Date(date).getTime() + Math.max(remainingSeconds, 1) * 1000 + 5 * 1000);
}

function normalizeHourlyCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.trunc(number), 0) : 0;
}

function getCxHourlyPlacedCalls(item = {}, asOf = new Date()) {
  const hourKey = getPacificHourKey(asOf);
  const itemHourKey = String(item.hourlyPlacedHourKey || item.metadata?.hourlyPlacedHourKey || "").trim();
  if (itemHourKey !== hourKey) return 0;
  return normalizeHourlyCount(item.hourlyPlacedCalls ?? item.metadata?.hourlyPlacedCalls ?? 0);
}

function buildCxHourlyAttemptPatch(item = {}, placedAt = new Date()) {
  const hourKey = getPacificHourKey(placedAt);
  const priorHourKey = String(item.hourlyPlacedHourKey || item.metadata?.hourlyPlacedHourKey || "").trim();
  const priorHourlyCount = priorHourKey === hourKey
    ? getCxHourlyPlacedCalls(item, placedAt)
    : 0;
  const nextHourlyCount = priorHourlyCount + 1;
  return {
    hourlyPlacedHourKey: hourKey,
    hourlyPlacedCalls: nextHourlyCount,
    "metadata.hourlyPlacedHourKey": hourKey,
    "metadata.hourlyPlacedCalls": nextHourlyCount,
  };
}

function getCxHourlyCapForQueueFamily(queueFamily) {
  if (!readBooleanEnv("RC_CX_HOURLY_CAPS_ENABLED", true)) return null;
  const family = normalizeLeadQueueFamily(queueFamily);
  if (family === "fresh-day1") {
    return readNonNegativeIntegerEnv(
      "RC_CX_GREEN_HOURLY_CAP",
      readNonNegativeIntegerEnv("RC_CX_FRESH_HOURLY_CAP", 3),
    );
  }
  if (family === "fresh-day2to10") {
    return readNonNegativeIntegerEnv(
      "RC_CX_BLUE_HOURLY_CAP",
      readNonNegativeIntegerEnv("RC_CX_DAY2TO15_HOURLY_CAP", 2),
    );
  }
  return null;
}

function getCxHourlyPacingStatus(item = {}, now = new Date()) {
  const family = normalizeLeadQueueFamily(item.queueFamily || item.metadata?.queueFamily || "");
  const cap = getCxHourlyCapForQueueFamily(family);
  const count = getCxHourlyPlacedCalls(item, now);
  const capped = cap != null && cap > 0 && count >= cap;
  return {
    family,
    cap,
    count,
    remaining: cap == null || cap <= 0 ? null : Math.max(cap - count, 0),
    hourKey: getPacificHourKey(now),
    capped,
    nextEligibleAt: capped ? getNextPacificHourBoundary(now) : null,
  };
}

function isFreshFirstContactQueueItem(item = {}) {
  const family = normalizeLeadQueueFamily(item.queueFamily || item.ageBucket || item.currentStage || "");
  if (family !== "fresh-day1") return false;
  const stageIndex = Number(item.progressiveStageIndex);
  if (Number.isFinite(stageIndex) && stageIndex > 0) return false;
  const placedCalls = Number(item.placedCalls ?? item.dailyPlacedCalls ?? item.metadata?.placedCalls ?? 0);
  return !Number.isFinite(placedCalls) || placedCalls <= 0;
}

function isImmediateSmsHotIntentQueueItem(item = {}) {
  const urgency = String(item.smsCallbackUrgency || item.metadata?.smsCallbackUrgency || "").trim().toLowerCase();
  const lane = String(item.priorityLane || item.metadata?.priorityLane || "").trim().toLowerCase();
  const route = String(item.intakeRoute || item.metadata?.intakeRoute || "").trim().toLowerCase();
  return urgency === "immediate-hot" || lane === "sms-hot-intent" || route === "sms-hot-intent-now";
}

function getGreenBlueParityAfterHourlyCalls() {
  return readNonNegativeIntegerEnv("RC_CX_GREEN_BLUE_PARITY_AFTER_HOURLY_CALLS", 2);
}

function getCxQueueServeRank(item = {}, options = {}) {
  const family = normalizeLeadQueueFamily(item.queueFamily || item.ageBucket || item.currentStage || "");
  const now = options.now || new Date();

  if (family === "fresh-day1") {
    if (isImmediateSmsHotIntentQueueItem(item)) return -0.5;
    if (isFreshFirstContactQueueItem(item)) return 0;
    const hourlyCalls = getCxHourlyPlacedCalls(item, now);
    return hourlyCalls >= getGreenBlueParityAfterHourlyCalls() ? 1 : 0.5;
  }
  if (family === "fresh-day2to10") return 1;
  if (family === "aged") return 2;
  return 99;
}

module.exports = {
  buildCxHourlyAttemptPatch,
  getCxHourlyCapForQueueFamily,
  getCxHourlyPacingStatus,
  getCxHourlyPlacedCalls,
  getCxQueueServeRank,
  getPacificHourKey,
  isFreshFirstContactQueueItem,
};
