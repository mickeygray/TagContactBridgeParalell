"use strict";

const UCQ_AGE_BUCKETS = new Set([
  "just_came_in",
  "second_contact",
  "third_contact",
  "day2_10",
  "day16_30",
  "aged",
  "dead",
]);

const FRESH_AGE_BUCKETS = new Set([
  "just_came_in",
  "second_contact",
  "third_contact",
]);

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function compactText(value) {
  return normalizeText(value)
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeUcqAgeBucket(value) {
  const normalized = normalizeText(value).replace(/[-\s]+/g, "_");
  return UCQ_AGE_BUCKETS.has(normalized) ? normalized : null;
}

function normalizeLeadQueueFamily(value) {
  const normalized = compactText(value);
  if (!normalized) return "unassigned";
  if (
    normalized === "fresh-day1"
    || normalized === "day0"
    || normalized === "day-0"
    || normalized === "day1"
    || normalized === "day-1"
    || normalized === "first-day"
    || normalized === "fresh"
    || normalized === "hot"
    || normalized === "new"
    || normalized === "green"
    || normalized === "green-priority"
    || normalized === "green-second-tier"
    || normalized === "zero-contact"
    || normalized === "0-contact"
    || normalized === "first-contact"
    || normalized === "day1-0-contact"
    || normalized === "day-1-0-contact"
    || normalized === "day1-second-contact"
    || normalized === "day-1-second-contact"
    || normalized === "day1-2nd-contact"
    || normalized === "day-1-2nd-contact"
    || normalized === "just-came-in"
  ) {
    return "fresh-day1";
  }
  if (
    normalized === "fresh-day2to10"
    || normalized === "fresh-day2to15"
    || normalized === "day2to10"
    || normalized === "day2to15"
    || normalized === "day-2to10"
    || normalized === "day-2to15"
    || normalized === "day2-10"
    || normalized === "day2-15"
    || normalized === "day-2-10"
    || normalized === "day-2-15"
    || normalized === "day10"
    || normalized === "day15"
    || normalized === "later"
    || normalized === "blue"
    || normalized === "blue/red"
    || normalized === "blue-red"
    || normalized === "old-balanced"
    || normalized === "nonfresh"
    || normalized === "non-fresh"
    || normalized === "day2_10"
    || normalized === "day2_15"
    || normalized.includes("2-10")
    || normalized.includes("2-15")
    || normalized.includes("day2")
  ) {
    return "fresh-day2to10";
  }
  if (
    normalized === "fresh-day16to30"
    || normalized === "day16to30"
    || normalized === "day-16to30"
    || normalized === "day16-30"
    || normalized === "day-16-30"
    || normalized === "day16_30"
    || normalized === "yellow"
    || normalized.includes("16-30")
    || normalized.includes("day16")
  ) {
    return "fresh-day16to30";
  }
  if (
    normalized === "aged"
    || normalized === "red"
    || normalized === "red-only"
    || normalized === "aged-only"
    || normalized === "old-only"
    || normalized.includes("aged")
    || normalized.includes("prospect")
    || normalized.includes("filler")
  ) {
    return "aged";
  }
  if (
    normalized === "dead"
    || normalized === "expired"
    || normalized === "do-not-dial"
    || normalized === "do-not-queue"
  ) {
    return "dead";
  }
  return "unassigned";
}

function expandLeadQueueFamilyFilter(value) {
  const normalized = compactText(value);
  if (!normalized) return [];
  if (
    normalized === "blue/red"
    || normalized === "blue-red"
    || normalized === "blue-red-only"
    || normalized === "old-balanced"
    || normalized === "old"
    || normalized === "nonfresh"
    || normalized === "non-fresh"
    || normalized === "fallback"
  ) {
    return ["fresh-day2to10", "fresh-day16to30", "aged"];
  }
  const family = normalizeLeadQueueFamily(value);
  return family === "unassigned" ? [] : [family];
}

function normalizeLeadQueueFamilyList(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = raw.flatMap(expandLeadQueueFamilyFilter);
  const unique = Array.from(new Set(normalized));
  if (unique.length > 0) return unique;
  return Array.from(
    new Set(
      (Array.isArray(fallback) ? fallback : [fallback])
        .flatMap(expandLeadQueueFamilyFilter),
    ),
  );
}

function normalizeCxQueuePolicyTier(value) {
  const normalized = compactText(value).replace(/\//g, "-");
  if (!normalized) return null;
  if (
    normalized === "no-leads"
    || normalized === "none"
    || normalized === "off"
    || normalized === "disabled"
  ) {
    return "no_leads";
  }
  if (
    normalized === "fresh-priority"
    || normalized === "green-priority"
    || normalized === "priority-green"
    || normalized === "green"
  ) {
    return "fresh_priority";
  }
  if (
    normalized === "fresh-capped"
    || normalized === "green-second-tier"
    || normalized === "green-second"
    || normalized === "green-2nd-tier"
    || normalized === "green-2"
    || normalized === "second-green"
  ) {
    return "fresh_capped";
  }
  if (
    normalized === "old-balanced"
    || normalized === "blue-red"
    || normalized === "blue"
    || normalized === "blue-red-only"
    || normalized === "balanced"
    || normalized === "old"
  ) {
    return "old_balanced";
  }
  if (
    normalized === "red-only"
    || normalized === "red"
    || normalized === "aged-only"
    || normalized === "aged"
  ) {
    return "red_only";
  }
  const underscore = normalized.replace(/-/g, "_");
  return [
    "no_leads",
    "red_only",
    "old_balanced",
    "fresh_capped",
    "fresh_priority",
  ].includes(underscore)
    ? underscore
    : null;
}

function readNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function sourceText(source = {}, cadence = {}) {
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const cadenceAction = cadence?.action && typeof cadence.action === "object" ? cadence.action : {};
  return [
    source.key,
    source.actionKey,
    source.queueKey,
    source.progressiveStageKey,
    source.progressiveStageLabel,
    source.currentStage,
    source.nextActionType,
    metadata.actionKey,
    metadata.queueBucket,
    metadata.ageBucket,
    metadata.progressiveStageKey,
    metadata.progressiveStageLabel,
    metadata.currentStage,
    metadata.nextActionType,
    cadenceAction.key,
  ].map(compactText).filter(Boolean).join(" ");
}

function textHasAny(text, tokens = []) {
  return tokens.some((token) => text.includes(token));
}

function deriveDayOneAgeBucket(source = {}, cadence = {}) {
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const callPlan = source?.callPlan && typeof source.callPlan === "object"
    ? source.callPlan
    : metadata.callPlan && typeof metadata.callPlan === "object"
      ? metadata.callPlan
      : {};
  const text = sourceText(source, cadence);

  if (textHasAny(text, [
    "cx-day0-3",
    "cx-day-0-3",
    "third-contact",
    "thirdcontact",
    "day1-3",
    "day-1-3",
    "day0-3",
    "contact-3",
    "3rd",
  ])) {
    return "third_contact";
  }
  if (textHasAny(text, [
    "cx-day0-2",
    "cx-day-0-2",
    "second-contact",
    "secondcontact",
    "day1-2",
    "day-1-2",
    "day0-2",
    "contact-2",
    "2nd",
  ])) {
    return "second_contact";
  }

  const stageIndex = readNumber(source.progressiveStageIndex, metadata.progressiveStageIndex);
  if (stageIndex === 2) return "third_contact";
  if (stageIndex === 1) return "second_contact";
  if (stageIndex === 0) return "just_came_in";

  const placedCalls = Math.max(readNumber(
    source.placedCalls,
    metadata.placedCalls,
    source.dailyPlacedCalls,
    metadata.dailyPlacedCalls,
  ) ?? 0, 0);
  const phaseIndex = Math.max(readNumber(callPlan.phaseIndex, metadata.phaseIndex) ?? 0, 0);
  const contactAttempt = readNumber(
    source.contactAttempt,
    source.attemptNumber,
    metadata.contactAttempt,
    metadata.attemptNumber,
  );
  const attemptIndex = contactAttempt && contactAttempt > 0 ? contactAttempt - 1 : 0;
  const journeyIndex = Math.max(placedCalls, phaseIndex, attemptIndex);
  if (journeyIndex >= 2) return "third_contact";
  if (journeyIndex >= 1) return "second_contact";
  return "just_came_in";
}

function deriveUcqAgeBucket(source = {}, cadence = {}) {
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const explicitBucket = normalizeUcqAgeBucket(source.ageBucket || metadata.ageBucket);
  if (explicitBucket) return explicitBucket;

  const text = sourceText(source, cadence);
  if (textHasAny(text, ["cx-day0", "cx-day-0", "second-contact", "third-contact", "just-came-in"])) {
    return deriveDayOneAgeBucket(source, cadence);
  }

  const family = normalizeLeadQueueFamily(
    source.queueFamily
      || source.leadQueueFamily
      || source.queueTier
      || metadata.queueFamily
      || metadata.leadQueueFamily
      || metadata.queueTier,
  );
  if (family === "dead") return "dead";
  if (family === "aged") return "aged";
  if (family === "fresh-day16to30") return "day16_30";
  if (family === "fresh-day2to10") return "day2_10";
  if (family === "fresh-day1") return deriveDayOneAgeBucket(source, cadence);

  if (textHasAny(text, ["aged", "red-only", "filler", "prospect"])) return "aged";
  if (textHasAny(text, ["day2", "2-10", "2-15", "blue"])) return "day2_10";
  if (textHasAny(text, ["day0", "day-0", "day1", "day-1", "contact"])) {
    return deriveDayOneAgeBucket(source, cadence);
  }

  const cadenceCallPlan = cadence?.schedule?.callPlan && typeof cadence.schedule.callPlan === "object"
    ? cadence.schedule.callPlan
    : cadence?.callPlan && typeof cadence.callPlan === "object"
      ? cadence.callPlan
      : {};
  const callPlan = source?.callPlan && typeof source.callPlan === "object"
    ? source.callPlan
    : metadata.callPlan && typeof metadata.callPlan === "object"
      ? metadata.callPlan
      : {};
  const activeDay = readNumber(
    source.activeDay,
    source.queueDayIndex,
    callPlan.activeDay,
    metadata.activeDay,
    metadata.queueDayIndex,
    cadenceCallPlan.activeDay,
  );
  if (activeDay !== null) {
    if (activeDay <= 2) return deriveDayOneAgeBucket(source, cadence);
    if (activeDay <= 15) return "day2_10";
    if (activeDay <= 30) return "day16_30";
    if (activeDay > 120) return "dead";
    return "aged";
  }

  return "day2_10";
}

function deriveUcqPartition(ageBucket) {
  return FRESH_AGE_BUCKETS.has(normalizeUcqAgeBucket(ageBucket)) ? "fresh" : "non_fresh";
}

module.exports = {
  deriveDayOneAgeBucket,
  deriveUcqAgeBucket,
  deriveUcqPartition,
  normalizeCxQueuePolicyTier,
  normalizeLeadQueueFamily,
  normalizeLeadQueueFamilyList,
  normalizeUcqAgeBucket,
};
