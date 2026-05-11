"use strict";

// businessHoursGuard — pure functions deciding "is now in the queue's
// operating window?" and "when's the next operating moment?". Used by
// every queue/assignment service to short-circuit outside business hours.
//
// All time logic is timezone-aware. We compute the wall-clock hour and
// day in PacingConfig.businessHoursTimezone (default America/Los_Angeles)
// and compare against the configured window.
//
// Channel-specific operating hours are layered: each channel can opt out
// of business-hours via `respectsBusinessHours: false` (default for email).
//
// Holidays: array of "YYYY-MM-DD" strings interpreted in the config's
// timezone. If today's date matches any of them, every channel-with-
// business-hours is considered closed.

function getZonedParts(date, timezone) {
  // Returns {year, month, day, hour, minute, weekday} for `date` in
  // the given IANA timezone, using Intl.DateTimeFormat (no extra deps).
  // weekday: 0=Sun..6=Sat (matches JS getDay convention).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const lookup = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekdayShort = lookup("weekday");
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parseInt(lookup("hour"), 10);
  return {
    year: parseInt(lookup("year"), 10),
    month: parseInt(lookup("month"), 10),
    day: parseInt(lookup("day"), 10),
    hour: hour === 24 ? 0 : hour,
    minute: parseInt(lookup("minute"), 10),
    weekday: weekdayMap[weekdayShort] ?? 0,
  };
}

function formatYmd({ year, month, day }) {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function formatHourBucket(date, timezone) {
  const { year, month, day, hour } = getZonedParts(date, timezone);
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  const h = String(hour).padStart(2, "0");
  return `${year}-${m}-${d}-${h}`;
}

// ── Top-level guard ────────────────────────────────────────────────

function isOperatingNow(config, asOf = new Date()) {
  if (!config) return false;
  if (config.enabled === false) return false;

  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const parts = getZonedParts(asOf, tz);

  // Holiday check
  const ymd = formatYmd(parts);
  const holidays = Array.isArray(config.holidays) ? config.holidays : [];
  if (holidays.includes(ymd)) return false;

  // Day check
  const days = Array.isArray(config.businessDays) ? config.businessDays : [1, 2, 3, 4, 5];
  if (!days.includes(parts.weekday)) return false;

  // Hour window check (end is exclusive: [start, end))
  const startHour = Number.isFinite(config.businessHoursStart) ? config.businessHoursStart : 8;
  const endHour = Number.isFinite(config.businessHoursEnd) ? config.businessHoursEnd : 18;
  if (parts.hour < startHour || parts.hour >= endHour) return false;

  return true;
}

// ── Channel-specific guard ─────────────────────────────────────────
//
// `channel` is one of "voice" | "sms" | "rvm" | "email" (and any other
// keys present in config.channelOperatingHours).
//
// If the channel has `respectsBusinessHours: false`, returns true
// regardless of clock/day. Otherwise applies top-level + per-channel
// overrides.

function isChannelOperatingNow(config, channel, asOf = new Date()) {
  if (!config) return false;
  if (config.enabled === false) return false;

  const channelCfg = config.channelOperatingHours?.[channel];
  // Unknown channel → fall back to top-level rule
  if (!channelCfg) return isOperatingNow(config, asOf);
  if (channelCfg.respectsBusinessHours === false) return true;

  // Use channel-level overrides if set, else inherit from top-level
  const effective = {
    ...config,
    businessHoursStart: channelCfg.startHour ?? config.businessHoursStart,
    businessHoursEnd: channelCfg.endHour ?? config.businessHoursEnd,
    businessDays: channelCfg.days ?? config.businessDays,
  };
  return isOperatingNow(effective, asOf);
}

// ── Forward-shifting helpers ───────────────────────────────────────
//
// Given a target Date that falls outside operating hours, return the
// next moment that IS inside operating hours. Used by the cadence
// engine to clamp scheduled-touches.

function clampToOperatingHours(scheduledAt, config) {
  if (isOperatingNow(config, scheduledAt)) return scheduledAt;
  return nextOperatingMomentAfter(scheduledAt, config);
}

function clampToChannelOperatingHours(scheduledAt, channel, config) {
  if (!config) return scheduledAt;
  const channelCfg = config.channelOperatingHours?.[channel];
  if (channelCfg?.respectsBusinessHours === false) return scheduledAt;
  return clampToOperatingHours(scheduledAt, config);
}

function nextOperatingMomentAfter(date, config, lookAheadDays = 14) {
  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const startHour = Number.isFinite(config.businessHoursStart) ? config.businessHoursStart : 8;

  // Walk forward day by day until we find an operating day; then return
  // either the original time (if it's after start) or that day's start.
  let probe = new Date(date.getTime());
  for (let i = 0; i < lookAheadDays * 24 * 4; i += 1) {
    if (isOperatingNow(config, probe)) return probe;
    // Advance to next operating-window-start candidate. Cheap heuristic:
    // if the current zoned hour is before the window, jump to the
    // window start same day; otherwise jump to next day's window start.
    const parts = getZonedParts(probe, tz);
    const targetMinute = 0;
    if (parts.hour < startHour) {
      // Same day, advance to startHour:00
      const advanceMs = ((startHour - parts.hour) * 60 - parts.minute) * 60 * 1000;
      probe = new Date(probe.getTime() + Math.max(advanceMs, 60_000));
    } else {
      // Past today's window — jump to tomorrow's start. Approximate by
      // adding (24 - parts.hour + startHour) hours minus current minute.
      const advanceMs = ((24 - parts.hour + startHour) * 60 - parts.minute) * 60 * 1000;
      probe = new Date(probe.getTime() + Math.max(advanceMs, 60_000));
    }
  }
  // Fallback: return the original (shouldn't happen with sane config)
  return date;
}

// ── Agent login window ─────────────────────────────────────────────
//
// Non-admin users can only obtain a JWT inside this window, and their
// JWT expiry is clamped to today's window-end so they're auto-logged-out
// at end-of-window. Admins are exempt entirely.

function isAgentLoginWindowOpen(config, asOf = new Date()) {
  if (!config) return false;
  // Use agentLogin* fields if present. Login is intentionally wider than
  // dialing business hours so agents can wrap up after the call window.
  const tz = config.agentLoginTimezone
    || config.businessHoursTimezone
    || "America/Los_Angeles";
  const startHour = Number.isFinite(config.agentLoginStartHour)
    ? config.agentLoginStartHour
    : (Number.isFinite(config.businessHoursStart) ? config.businessHoursStart : 7);
  const endHour = Number.isFinite(config.agentLoginEndHour)
    ? config.agentLoginEndHour
    : 18;
  const days = Array.isArray(config.agentLoginDays) && config.agentLoginDays.length
    ? config.agentLoginDays
    : (Array.isArray(config.businessDays) ? config.businessDays : [1, 2, 3, 4, 5]);

  const parts = getZonedParts(asOf, tz);
  const ymd = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const holidays = Array.isArray(config.holidays) ? config.holidays : [];
  if (holidays.includes(ymd)) return false;
  if (!days.includes(parts.weekday)) return false;
  if (parts.hour < startHour || parts.hour >= endHour) return false;
  return true;
}

// Compute the UTC instant for "today's end-of-window in tz" relative to
// asOf. Returns null if asOf isn't currently inside a window-open day.
//
// Math approach: minutes between now and window-end =
//   (endHour - currentZonedHour) * 60 - currentZonedMinute
//
// This is correct as long as there's no DST transition between asOf and
// window-end. For the default 7-17 window in America/Los_Angeles, DST
// transitions happen at 2am which is never inside the window — so the
// math always holds. Documented here for the next person who looks.
function todaysAgentLoginWindowClose(config, asOf = new Date()) {
  if (!isAgentLoginWindowOpen(config, asOf)) return null;
  const tz = config.agentLoginTimezone
    || config.businessHoursTimezone
    || "America/Los_Angeles";
  const endHour = Number.isFinite(config.agentLoginEndHour)
    ? config.agentLoginEndHour
    : 18;

  const parts = getZonedParts(asOf, tz);
  // Minutes from now until endHour:00 same day, in zone
  const minutesToEnd = (endHour - parts.hour) * 60 - parts.minute;
  if (minutesToEnd <= 0) return null;
  return new Date(asOf.getTime() + minutesToEnd * 60 * 1000);
}

module.exports = {
  isOperatingNow,
  isChannelOperatingNow,
  clampToOperatingHours,
  clampToChannelOperatingHours,
  nextOperatingMomentAfter,
  formatHourBucket,
  getZonedParts,
  isAgentLoginWindowOpen,
  todaysAgentLoginWindowClose,
};
