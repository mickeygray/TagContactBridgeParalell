"use strict";

const { getCompanyConfig } = require("../../shared-config/src");

// TCPA defaults: FCC rule limits marketing voice calls + SMS to 8am-9pm
// recipient-local time. We go conservative (8pm end) to keep operators
// well inside the safe window and leave buffer for clock skew across
// zones. `contactEndHour` env overrides win if set, but we cap at 21
// so an aggressive config can't wander past TCPA.
const TCPA_START_HOUR = 8;
const TCPA_END_HOUR = 20; // 8pm local — one hour shy of the 9pm cap
const TCPA_HARD_CAP_HOUR = 21;

// US federal holidays + commonly-respected observances. Dates are
// ISO YYYY-MM-DD in recipient-local time; the check below compares
// against the policy's `timezone`. Keep as an explicit list so the
// ops team can prune/extend without a calendar library.
const US_CONTACT_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr Day
  "2026-02-16", // Presidents Day
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-07-04", // Independence Day
  "2026-09-07", // Labor Day
  "2026-10-12", // Columbus Day
  "2026-11-11", // Veterans Day
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2026-12-25", // Christmas
  "2026-12-31", // NYE
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-05-31",
  "2027-06-18", // Juneteenth observed (falls Sat)
  "2027-06-19",
  "2027-07-05", // July 4 observed (falls Sun)
  "2027-09-06",
  "2027-10-11",
  "2027-11-11",
  "2027-11-25",
  "2027-11-26",
  "2027-12-24",
  "2027-12-25",
  "2027-12-31",
]);

function parseWeekdays(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
}

function formatDateInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA yields YYYY-MM-DD natively.
  return formatter.format(date);
}

function getTimezoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value || "";
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[weekdayLabel] ?? -1,
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
  };
}

function buildChannelPolicy(domain, channel) {
  const companyConfig = getCompanyConfig(domain);
  const cadence = companyConfig?.cadence || {};
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const timezone = cadence.timezone || "America/Los_Angeles";
  // TCPA applies Mon-Sun but we keep weekdays-only for proactive outreach
  // by default. `activeWeekdays` can be overridden per company; only
  // email gets the full week by default.
  const activeWeekdays = cadence.activeWeekdays || "1,2,3,4,5";
  const startHour = Math.max(
    TCPA_START_HOUR,
    Math.min(23, Number(cadence.contactStartHour) || TCPA_START_HOUR),
  );
  const configuredEndHour = Math.max(
    startHour + 1,
    Math.min(TCPA_HARD_CAP_HOUR, Number(cadence.contactEndHour) || TCPA_END_HOUR),
  );
  // Cap the configured end hour at TCPA's hard 9pm limit. Operators can't
  // widen past this from env config.
  const endHour = Math.min(configuredEndHour, TCPA_HARD_CAP_HOUR);

  // Email is NOT covered by TCPA — can send 24/7 any day. All other
  // channels (sms, voice, rvm, call) fall under TCPA's voice-call rules.
  if (normalizedChannel === "email") {
    return {
      channel: normalizedChannel,
      timezone,
      restricted: false,
      startHour,
      endHour,
      activeWeekdays: cadence.activeWeekdays || "0,1,2,3,4,5,6",
      honorHolidays: false,
    };
  }

  return {
    channel: normalizedChannel,
    timezone,
    restricted: true,
    startHour,
    endHour,
    activeWeekdays,
    honorHolidays: true,
  };
}

function findNextAllowedTime(date, policy) {
  if (!policy?.restricted) return new Date(date.getTime());

  const allowedWeekdays = parseWeekdays(policy.activeWeekdays || "0,1,2,3,4,5,6");
  let cursor = new Date(date.getTime());
  cursor.setSeconds(0, 0);

  for (let attempt = 0; attempt < 24 * 14 * 4; attempt += 1) {
    const parts = getTimezoneParts(cursor, policy.timezone);
    const inWeekday = allowedWeekdays.includes(parts.weekday);
    const inHourWindow = parts.hour >= policy.startHour && parts.hour < policy.endHour;
    const localDate = formatDateInZone(cursor, policy.timezone);
    const isHoliday = policy.honorHolidays && US_CONTACT_HOLIDAYS.has(localDate);

    if (inWeekday && inHourWindow && !isHoliday) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
  }

  return cursor;
}

function evaluateChannelContactTime(domain, channel, at = new Date()) {
  const policy = buildChannelPolicy(domain, channel);
  const target = new Date(at);
  const nextAllowedAt = findNextAllowedTime(target, policy);
  // `findNextAllowedTime` zeroes seconds/ms on its starting cursor, so an
  // exact-equality check would spuriously defer any call made mid-minute
  // even when we're firmly inside the window. Use `<=` instead — if the
  // next allowed time is now-or-earlier, we're in-window.
  const allowed = !policy.restricted || nextAllowedAt.getTime() <= target.getTime();

  // Figure out specifically WHY the time was blocked so the dispatcher
  // can choose to defer vs. cancel vs. alert. Holidays and TCPA both
  // delay to the next allowed slot; quiet-hours-only usually clear the
  // same day.
  let reason = null;
  if (!allowed) {
    const parts = getTimezoneParts(target, policy.timezone);
    const localDate = formatDateInZone(target, policy.timezone);
    const allowedWeekdays = parseWeekdays(policy.activeWeekdays || "0,1,2,3,4,5,6");
    if (policy.honorHolidays && US_CONTACT_HOLIDAYS.has(localDate)) {
      reason = "holiday";
    } else if (!allowedWeekdays.includes(parts.weekday)) {
      reason = "off-weekday";
    } else if (parts.hour < policy.startHour || parts.hour >= policy.endHour) {
      reason = "quiet-hours";
    } else {
      reason = "outside-contact-window";
    }
  }

  return {
    allowed,
    restricted: policy.restricted,
    timezone: policy.timezone,
    channel: policy.channel,
    nextAllowedAt,
    reason,
    policy: {
      startHour: policy.startHour,
      endHour: policy.endHour,
      activeWeekdays: policy.activeWeekdays,
      honorHolidays: policy.honorHolidays,
    },
  };
}

/**
 * Pure frequency-cap evaluator. Given a lead's cadence state counters
 * and the channel + cap being attempted, returns `{ allowed, reason,
 * remaining }`. Call at dispatch time BEFORE claiming a scheduled
 * action. Does not enforce across companies — each lead's LeadCadence
 * is scoped to one (domain, caseId).
 *
 * Expected `cadenceState` shape (from LeadCadence.cadenceState):
 *   { caps: { sms: 5, email: 10, rvm: 3 },
 *     completedByChannel: { sms: 2, email: 5, rvm: 1 },
 *     pendingByChannel: { sms: 1 }  (optional — not counted against cap) }
 *
 * Semantics: `completedByChannel[c] + pendingByChannel[c] < caps[c]`.
 * A cap of 0 means "never allow" (useful for lead-level blocks).
 * No cap entry at all = unlimited.
 */
function evaluateFrequencyCap(cadenceState, channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  const caps = cadenceState?.caps || {};
  const cap = caps[normalized];
  if (cap === undefined || cap === null) {
    return { allowed: true, reason: "no-cap-configured", remaining: null };
  }
  const capNum = Number(cap);
  if (!Number.isFinite(capNum) || capNum <= 0) {
    return { allowed: false, reason: "cap-zero-or-invalid", remaining: 0 };
  }
  const completed = Number(cadenceState?.completedByChannel?.[normalized] || 0);
  const pending = Number(cadenceState?.pendingByChannel?.[normalized] || 0);
  const used = completed + pending;
  const remaining = Math.max(0, capNum - used);
  if (used >= capNum) {
    return { allowed: false, reason: "cap-exhausted", remaining: 0 };
  }
  return { allowed: true, reason: null, remaining };
}

module.exports = {
  US_CONTACT_HOLIDAYS,
  TCPA_START_HOUR,
  TCPA_END_HOUR,
  TCPA_HARD_CAP_HOUR,
  buildChannelPolicy,
  evaluateChannelContactTime,
  evaluateFrequencyCap,
};
