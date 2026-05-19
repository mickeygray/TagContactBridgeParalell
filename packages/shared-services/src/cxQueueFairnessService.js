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

// Aging boost: a lead that has been queued for hours without a single
// touch today gradually moves up the rank toward fresh-day1 territory.
// Caps at 1.2 so an SMS hot intent (rank -0.5) still outranks even the
// most-aged untouched lead, but a 10-hour-old aged lead with zero touches
// lifts above an idle fresh-day2to10 (rank 1). Boost zeroes out the
// moment the lead is dialed today — agents won't see a touched lead
// keep climbing artificially.
//
// Knob: RC_CX_AGING_BOOST_PER_HOUR (default 0.15). RC_CX_AGING_BOOST_MAX
// (default 1.2). Set RC_CX_AGING_BOOST_PER_HOUR=0 to disable.
function getAgingBoostPerHour() {
  const raw = process.env.RC_CX_AGING_BOOST_PER_HOUR;
  if (raw === "" || raw === undefined || raw === null) return 0.15;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.15;
}

function getAgingBoostMax() {
  const raw = process.env.RC_CX_AGING_BOOST_MAX;
  if (raw === "" || raw === undefined || raw === null) return 1.2;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.2;
}

function computeAgingBoost(item, now) {
  // Don't boost leads that have already received attention today —
  // the boost is for COVERAGE, not for re-dial pacing (which the
  // existing cooldown logic handles).
  const dailyPlaced = Number(item?.dailyPlacedCalls || 0);
  if (dailyPlaced > 0) return 0;

  // Pick the most-recent "lead is waiting" timestamp we can find.
  // Fall back to createdAt; if nothing is set, no boost.
  const waitAnchor = item?.lastPlacedAt
    || item?.releaseAt
    || item?.queueEnteredAt
    || item?.createdAt
    || null;
  if (!waitAnchor) return 0;
  const anchorMs = new Date(waitAnchor).getTime();
  if (!Number.isFinite(anchorMs)) return 0;

  const hoursWaiting = Math.max(0, (now.getTime() - anchorMs) / 3_600_000);
  const perHour = getAgingBoostPerHour();
  if (perHour <= 0) return 0;
  return Math.min(getAgingBoostMax(), hoursWaiting * perHour);
}

function getCxQueueServeRank(item = {}, options = {}) {
  const family = normalizeLeadQueueFamily(item.queueFamily || item.ageBucket || item.currentStage || "");
  const now = options.now || new Date();

  let baseRank;
  if (family === "fresh-day1") {
    if (isImmediateSmsHotIntentQueueItem(item)) return -0.5;
    if (isFreshFirstContactQueueItem(item)) return 0;
    const hourlyCalls = getCxHourlyPlacedCalls(item, now);
    baseRank = hourlyCalls >= getGreenBlueParityAfterHourlyCalls() ? 1 : 0.5;
  } else if (family === "fresh-day2to10") {
    baseRank = 1;
  } else if (family === "aged") {
    baseRank = 2;
  } else {
    baseRank = 99;
  }

  return baseRank - computeAgingBoost(item, now);
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
