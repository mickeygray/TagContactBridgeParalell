"use strict";

function normalizeDateKey(dateKey) {
  const text = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error("dateKey must be YYYY-MM-DD");
    error.status = 400;
    throw error;
  }
  return text;
}

function parseDateKey(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  const [year, month, day] = normalized.split("-").map((value) => Number(value));
  return { year, month, day };
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const mapped = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      mapped[part.type] = part.value;
    }
  }

  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second),
  };
}

function zonedTimeToUtc(parts, timeZone) {
  const guessUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0),
    Number(parts.millisecond || 0),
  );

  const initialZoned = getZonedParts(new Date(guessUtcMs), timeZone);
  const initialZonedAsUtcMs = Date.UTC(
    initialZoned.year,
    initialZoned.month - 1,
    initialZoned.day,
    initialZoned.hour,
    initialZoned.minute,
    initialZoned.second,
    Number(parts.millisecond || 0),
  );
  const initialOffsetMs = initialZonedAsUtcMs - guessUtcMs;
  let resolvedUtcMs = guessUtcMs - initialOffsetMs;

  const resolvedZoned = getZonedParts(new Date(resolvedUtcMs), timeZone);
  if (
    resolvedZoned.year !== Number(parts.year) ||
    resolvedZoned.month !== Number(parts.month) ||
    resolvedZoned.day !== Number(parts.day) ||
    resolvedZoned.hour !== Number(parts.hour || 0) ||
    resolvedZoned.minute !== Number(parts.minute || 0) ||
    resolvedZoned.second !== Number(parts.second || 0)
  ) {
    const resolvedZonedAsUtcMs = Date.UTC(
      resolvedZoned.year,
      resolvedZoned.month - 1,
      resolvedZoned.day,
      resolvedZoned.hour,
      resolvedZoned.minute,
      resolvedZoned.second,
      Number(parts.millisecond || 0),
    );
    const resolvedOffsetMs = resolvedZonedAsUtcMs - resolvedUtcMs;
    resolvedUtcMs = guessUtcMs - resolvedOffsetMs;
  }

  return new Date(resolvedUtcMs);
}

function addLocalDays(parts, deltaDays) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  cursor.setUTCDate(cursor.getUTCDate() + Number(deltaDays || 0));
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
}

function buildTimezoneDateWindow(dateKey, timeZone = "America/Los_Angeles") {
  const startParts = parseDateKey(dateKey);
  const nextDayParts = addLocalDays(startParts, 1);
  const start = zonedTimeToUtc(
    { ...startParts, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone,
  );
  const nextDayStart = zonedTimeToUtc(
    { ...nextDayParts, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone,
  );
  return {
    start,
    end: new Date(nextDayStart.getTime() - 1),
  };
}

module.exports = {
  buildTimezoneDateWindow,
};
