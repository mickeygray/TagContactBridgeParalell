"use strict";

// Pure helper that computes the next federal-DNC recheck boundary
// for a given moment in time. The schedule per spec:
//
//   - 1st of every month
//   - First Monday on/after the 15th of every month
//
// Roughly two boundaries per month (~14 days apart, occasionally
// 17 days when the 15th lands midweek). All computations anchored
// to America/Los_Angeles so a "boundary" is the operator-time
// midnight on that calendar day, not UTC midnight.
//
// Input: a `Date` (typically `new Date()`).
// Output: a `Date` representing 00:00:00.000 PT on the next
// boundary date that is strictly after `now`.
//
// No DB or service deps — kept here so it can be unit-tested
// without a mongo handle.

const PT = "America/Los_Angeles";

// Get y/m/d/weekday in PT for a given Date. Weekday: 0=Sun … 6=Sat.
function ptParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? -1,
  };
}

// Build a Date that, when interpreted in PT, lands at 00:00:00 on
// the given y/m/d. Walks the offset for the target wall time so DST
// transitions land correctly.
function ptMidnight(year, month, day) {
  const naiveUtcMs = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`,
  );
  // Get the offset PT applies on that wall date.
  const sample = new Date(naiveUtcMs);
  const tzString = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    timeZoneName: "shortOffset",
  })
    .formatToParts(sample)
    .find((p) => p.type === "timeZoneName")?.value || "GMT-08:00";
  const match = String(tzString).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  let offsetMinutes = 0;
  if (match) {
    const sign = match[1] === "-" ? -1 : 1;
    offsetMinutes = sign * (Number(match[2] || 0) * 60 + Number(match[3] || 0));
  }
  // Wall time minus offset = UTC. PT offsetMinutes is negative,
  // so subtracting it adds time, which is correct.
  return new Date(naiveUtcMs - offsetMinutes * 60 * 1000);
}

// What's the day-of-month for the first Monday on/after the 15th
// of the given (year, month)?
function firstMondayAfter15thDay(year, month) {
  // Monday=1. Walk forward from the 15th until we hit a Monday.
  for (let day = 15; day <= 21; day += 1) {
    const probe = ptMidnight(year, month, day);
    if (ptParts(probe).weekday === 1) return day;
  }
  return 15; // unreachable — the 15th-21st always contains a Monday
}

function addMonths(year, month, delta) {
  // 1-based months. Returns new {year, month}.
  const idx = (month - 1) + delta;
  const newYear = year + Math.floor(idx / 12);
  const newMonth = ((idx % 12) + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}

/**
 * Compute the next federal-DNC recheck boundary strictly after `now`,
 * anchored to PT midnight. Returns a Date.
 *
 * Considers four candidates and picks the soonest future one:
 *   - First Monday after the 15th of the current month
 *   - 1st of next month
 *   - First Monday after the 15th of next month
 *   - 1st of month-after-next
 *
 * Including the "+2 month" candidates is overkill for normal flow
 * (always one of the first two will be future) but defends against
 * pathological inputs (e.g. now = end of month at exactly the
 * boundary) without special-casing.
 */
function nextRecheckBoundary(now = new Date()) {
  const parts = ptParts(now);
  const candidates = [];

  // Current month's mid-Mon
  candidates.push(
    ptMidnight(parts.year, parts.month, firstMondayAfter15thDay(parts.year, parts.month)),
  );
  // Next month's 1st
  const next = addMonths(parts.year, parts.month, 1);
  candidates.push(ptMidnight(next.year, next.month, 1));
  // Next month's mid-Mon
  candidates.push(
    ptMidnight(next.year, next.month, firstMondayAfter15thDay(next.year, next.month)),
  );
  // Month-after-next 1st
  const after = addMonths(parts.year, parts.month, 2);
  candidates.push(ptMidnight(after.year, after.month, 1));

  const future = candidates.filter((d) => d.getTime() > now.getTime());
  future.sort((a, b) => a.getTime() - b.getTime());
  return future[0] || candidates[candidates.length - 1];
}

/**
 * Initial check-time for a freshly-intaked lead: 30 days after
 * creation. The TrustedForm grace covers calls/RVMs for the first
 * 30 days regardless of DNC status, then the recheck cadence begins.
 */
function initialNextCheckAt(createdAt = new Date()) {
  return new Date(new Date(createdAt).getTime() + 30 * 24 * 60 * 60 * 1000);
}

module.exports = {
  nextRecheckBoundary,
  initialNextCheckAt,
  // Exposed for testing only — not for production callers.
  _internal: { ptParts, ptMidnight, firstMondayAfter15thDay, addMonths },
};
