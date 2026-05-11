"use strict";

function parseWeekdays(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
}

function getTimezoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
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
    year: Number(parts.find((part) => part.type === "year")?.value || 0),
    month: Number(parts.find((part) => part.type === "month")?.value || 0),
    day: Number(parts.find((part) => part.type === "day")?.value || 0),
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
  };
}

function findNextAllowedCadenceTime(date, cadenceConfig = {}) {
  const timezone = cadenceConfig.timezone || "America/Los_Angeles";
  const startHour = Math.max(0, Math.min(23, Number(cadenceConfig.contactStartHour) || 8));
  const endHour = Math.max(startHour + 1, Math.min(24, Number(cadenceConfig.contactEndHour) || 18));
  const allowedWeekdays = parseWeekdays(cadenceConfig.activeWeekdays || "0,1,2,3,4,5,6");

  let cursor = new Date(date.getTime());
  cursor.setSeconds(0, 0);

  for (let attempt = 0; attempt < 24 * 14 * 4; attempt += 1) {
    const parts = getTimezoneParts(cursor, timezone);
    const inWeekday = allowedWeekdays.includes(parts.weekday);
    const inHourWindow = parts.hour >= startHour && parts.hour < endHour;

    if (inWeekday && inHourWindow) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
  }

  return cursor;
}

function advanceToBusinessDay(baseDate, offsetDays, cadenceConfig = {}) {
  const timezone = cadenceConfig.timezone || "America/Los_Angeles";
  const allowedWeekdays = parseWeekdays(cadenceConfig.activeWeekdays || "1,2,3,4,5");
  let cursor = new Date(baseDate.getTime());
  cursor.setSeconds(0, 0);

  if (offsetDays <= 0) {
    return cursor;
  }

  let remaining = offsetDays;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    const parts = getTimezoneParts(cursor, timezone);
    if (allowedWeekdays.includes(parts.weekday)) {
      remaining -= 1;
    }
  }

  return cursor;
}

function withTimeOfDay(baseDate, hour, minute = 0) {
  const next = new Date(baseDate.getTime());
  next.setHours(hour, minute, 0, 0);
  return next;
}

function scheduleOnBusinessDay(now, offsetDays, hour, minute, cadenceConfig = {}) {
  const businessDay = advanceToBusinessDay(now, offsetDays, cadenceConfig);
  return findNextAllowedCadenceTime(withTimeOfDay(businessDay, hour, minute), cadenceConfig);
}

function sortActions(actions = []) {
  return [...actions].sort((left, right) => {
    const leftTime = new Date(left.scheduledFor).getTime();
    const rightTime = new Date(right.scheduledFor).getTime();
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.key).localeCompare(String(right.key));
  });
}

function buildNextActionSummary(actions = []) {
  const next = actions.find((entry) => entry.status === "pending");
  if (!next) {
    return {
      nextActionType: null,
      nextActionAt: null,
    };
  }

  return {
    nextActionType: `${next.channel}:${next.type}`,
    nextActionAt: next.scheduledFor,
  };
}

function createLegacyCadenceSchedule(now = new Date(), cadenceConfig = {}, validation = {}) {
  const timezone = cadenceConfig.timezone || "America/Los_Angeles";
  if (String(process.env.CADENCE_SCHEDULE_ACTIONS_ENABLED || "").toLowerCase() !== "true") {
    return {
      planVersion: "legacy-time-count-v1",
      timezone,
      nextActionType: null,
      nextActionAt: null,
      actions: [],
      timing: {
        mode: "legacy-time-count",
        smsCanSend: Boolean(validation.phoneCanText),
        emailCanSend: Boolean(validation.emailCanSend),
        rvmCanSend: Boolean(validation.phoneCanCall),
        cxCanQueue: Boolean(validation.phoneCanCall),
      },
    };
  }
  const actions = [];
  const enqueue = (
    key,
    type,
    channel,
    templateKey,
    scheduledFor,
    extra = {},
  ) => {
    actions.push({
      key,
      type,
      channel,
      templateKey,
      scheduledFor,
      status: "pending",
      contingentOnActionKey: extra.contingentOnActionKey || null,
      contingencyMode: extra.contingencyMode || null,
    });
  };

  const immediateBase = findNextAllowedCadenceTime(now, cadenceConfig);
  const emailBase = new Date(immediateBase.getTime());
  const textBase = new Date(immediateBase.getTime());
  const rvmBase = new Date(immediateBase.getTime());
  const dayZeroRvmOneAt = findNextAllowedCadenceTime(
    new Date(rvmBase.getTime() + 10 * 60 * 1000),
    cadenceConfig,
  );
  const dayZeroTextTwoAt = findNextAllowedCadenceTime(
    new Date(textBase.getTime() + 60 * 60 * 1000),
    cadenceConfig,
  );
  const dayZeroRvmTwoAt = findNextAllowedCadenceTime(
    new Date(rvmBase.getTime() + 125 * 60 * 1000),
    cadenceConfig,
  );
  const dayZeroSecondCallAt = findNextAllowedCadenceTime(
    new Date(rvmBase.getTime() + 2 * 60 * 60 * 1000),
    cadenceConfig,
  );
  const dayZeroThirdCallAt = findNextAllowedCadenceTime(
    new Date(rvmBase.getTime() + 4 * 60 * 60 * 1000),
    cadenceConfig,
  );

  if (validation.emailCanSend) {
    enqueue(
      "email-1",
      "welcome-email",
      "email",
      "prospect-welcome-email",
      emailBase,
    );
    enqueue(
      "email-2",
      "follow-up-email",
      "email",
      "prospect-follow-up-2-email",
      scheduleOnBusinessDay(now, 1, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-3",
      "follow-up-email",
      "email",
      "prospect-follow-up-3-email",
      scheduleOnBusinessDay(now, 3, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-4",
      "follow-up-email",
      "email",
      "prospect-follow-up-4-email",
      scheduleOnBusinessDay(now, 5, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-5",
      "follow-up-email",
      "email",
      "prospect-follow-up-5-email",
      scheduleOnBusinessDay(now, 7, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-6",
      "follow-up-email",
      "email",
      "prospect-follow-up-6-email",
      scheduleOnBusinessDay(now, 9, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-7",
      "weekly-follow-up-email",
      "email",
      "prospect-follow-up-7-email",
      scheduleOnBusinessDay(now, 14, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-8",
      "weekly-follow-up-email",
      "email",
      "prospect-follow-up-8-email",
      scheduleOnBusinessDay(now, 21, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-9",
      "weekly-follow-up-email",
      "email",
      "prospect-follow-up-9-email",
      scheduleOnBusinessDay(now, 28, 10, 0, cadenceConfig),
    );
    enqueue(
      "email-10",
      "weekly-follow-up-email",
      "email",
      "prospect-follow-up-10-email",
      scheduleOnBusinessDay(now, 35, 10, 0, cadenceConfig),
    );
  }

  if (validation.phoneCanText) {
    enqueue(
      "text-1",
      "first-text",
      "sms",
      "prospect-first-text",
      textBase,
    );
    enqueue(
      "text-2",
      "follow-up-text",
      "sms",
      "prospect-follow-up-text-2",
      dayZeroTextTwoAt,
    );
    enqueue(
      "text-3",
      "follow-up-text",
      "sms",
      "prospect-follow-up-text-3",
      scheduleOnBusinessDay(now, 1, 9, 0, cadenceConfig),
    );
    enqueue(
      "text-4",
      "follow-up-text",
      "sms",
      "prospect-follow-up-text-4",
      scheduleOnBusinessDay(now, 2, 9, 0, cadenceConfig),
    );
    enqueue(
      "text-5",
      "follow-up-text",
      "sms",
      "prospect-follow-up-text-5",
      scheduleOnBusinessDay(now, 5, 9, 0, cadenceConfig),
    );
  }

  if (validation.phoneCanCall) {
    enqueue(
      "cx-day0-1",
      "cx-call",
      "cx",
      "prospect-cx-call-day0-1",
      findNextAllowedCadenceTime(
        new Date(rvmBase.getTime() + 5 * 60 * 1000),
        cadenceConfig,
      ),
    );
    enqueue(
      "rvm-1",
      "drop-rvm",
      "rvm",
      "prospect-rvm-1",
      dayZeroRvmOneAt,
      {
        contingentOnActionKey: "cx-day0-1",
        contingencyMode: "skip-if-connected",
      },
    );
    enqueue(
      "cx-day0-2",
      "cx-call",
      "cx",
      "prospect-cx-call-day0-2",
      dayZeroSecondCallAt,
    );
    enqueue(
      "rvm-2",
      "drop-rvm",
      "rvm",
      "prospect-rvm-2",
      dayZeroRvmTwoAt,
      {
        contingentOnActionKey: "cx-day0-2",
        contingencyMode: "skip-if-connected",
      },
    );
    enqueue(
      "cx-day0-3",
      "cx-call",
      "cx",
      "prospect-cx-call-day0-3",
      dayZeroThirdCallAt,
    );
    enqueue(
      "rvm-3",
      "drop-rvm",
      "rvm",
      "prospect-rvm-3",
      scheduleOnBusinessDay(now, 1, 11, 0, cadenceConfig),
    );
    enqueue(
      "rvm-4",
      "drop-rvm",
      "rvm",
      "prospect-rvm-4",
      scheduleOnBusinessDay(now, 1, 13, 0, cadenceConfig),
    );
    enqueue(
      "rvm-5",
      "drop-rvm",
      "rvm",
      "prospect-rvm-5",
      scheduleOnBusinessDay(now, 2, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-6",
      "drop-rvm",
      "rvm",
      "prospect-rvm-6",
      scheduleOnBusinessDay(now, 3, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-7",
      "drop-rvm",
      "rvm",
      "prospect-rvm-7",
      scheduleOnBusinessDay(now, 4, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-8",
      "drop-rvm",
      "rvm",
      "prospect-rvm-8",
      scheduleOnBusinessDay(now, 5, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-9",
      "drop-rvm",
      "rvm",
      "prospect-rvm-9",
      scheduleOnBusinessDay(now, 6, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-10",
      "drop-rvm",
      "rvm",
      "prospect-rvm-10",
      scheduleOnBusinessDay(now, 7, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-11",
      "drop-rvm",
      "rvm",
      "prospect-rvm-11",
      scheduleOnBusinessDay(now, 8, 12, 0, cadenceConfig),
    );
    enqueue(
      "rvm-12",
      "drop-rvm",
      "rvm",
      "prospect-rvm-12",
      scheduleOnBusinessDay(now, 9, 12, 0, cadenceConfig),
    );

    enqueue(
      "cx-1",
      "cx-call",
      "cx",
      "prospect-cx-call-1",
      scheduleOnBusinessDay(now, 6, 14, 0, cadenceConfig),
    );
    enqueue(
      "cx-2",
      "cx-call",
      "cx",
      "prospect-cx-call-2",
      scheduleOnBusinessDay(now, 7, 14, 0, cadenceConfig),
    );
    enqueue(
      "cx-3",
      "cx-call",
      "cx",
      "prospect-cx-call-3",
      scheduleOnBusinessDay(now, 8, 14, 0, cadenceConfig),
    );
    enqueue(
      "cx-4",
      "cx-call",
      "cx",
      "prospect-cx-call-4",
      scheduleOnBusinessDay(now, 9, 14, 0, cadenceConfig),
    );
    enqueue(
      "cx-5",
      "cx-call",
      "cx",
      "prospect-cx-call-5",
      scheduleOnBusinessDay(now, 10, 14, 0, cadenceConfig),
    );
  }

  const sortedActions = sortActions(actions);
  const next = buildNextActionSummary(sortedActions);

  return {
    planVersion: "legacy-v4",
    timezone,
    ...next,
    actions: sortedActions,
    timing: {
      mode: "legacy-cadence",
      smsCount: sortedActions.filter((entry) => entry.channel === "sms").length,
      emailCount: sortedActions.filter((entry) => entry.channel === "email").length,
      rvmCount: sortedActions.filter((entry) => entry.channel === "rvm").length,
      cxCount: sortedActions.filter((entry) => entry.channel === "cx").length,
    },
  };
}

module.exports = {
  createLegacyCadenceSchedule,
};
