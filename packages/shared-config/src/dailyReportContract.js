"use strict";

// ONE VOCABULARY FOR THE NIGHTLY REPORT AND ITS STORED DAY.
//
// This contract lives in shared-config so models and services can both consume
// it without making the model layer depend on service code.

const REPORT_SECTION_IDS = Object.freeze({
  TOPLINE: "topline",
  BY_SOURCE: "source",
  BY_AGENT: "ldcalls",
  STATUS: "status",
  LONG_CALLS: "longcalls",
});

const ROLLUP_SECTION_IDS = Object.freeze([
  REPORT_SECTION_IDS.TOPLINE,
  REPORT_SECTION_IDS.BY_SOURCE,
  REPORT_SECTION_IDS.BY_AGENT,
  REPORT_SECTION_IDS.STATUS,
  REPORT_SECTION_IDS.LONG_CALLS,
]);

const DAILY_SECTION_KEYS = Object.freeze({
  SPEND: "spend",
  FINANCIAL: "financial",
  CALLS: "calls",
  CALL_HIGHLIGHTS: "callHighlights",
  ACTIVITY: "activity",
  BY_SOURCE: "bySource",
  BY_AGENT: "byAgent",
  STATUS: "statusMovement",
});

// The nightly report gather owns these sections. Calls and activity are
// contributed by their dedicated index/review paths and must never be erased
// merely because the report gather cannot see them.
const REPORT_OWNED_DAILY_SECTION_KEYS = Object.freeze([
  DAILY_SECTION_KEYS.SPEND,
  DAILY_SECTION_KEYS.FINANCIAL,
  DAILY_SECTION_KEYS.BY_SOURCE,
  DAILY_SECTION_KEYS.BY_AGENT,
  DAILY_SECTION_KEYS.STATUS,
  DAILY_SECTION_KEYS.CALL_HIGHLIGHTS,
]);

const AUXILIARY_DAILY_SECTION_KEYS = Object.freeze([
  DAILY_SECTION_KEYS.CALLS,
  DAILY_SECTION_KEYS.ACTIVITY,
]);

const REPORT_TO_DAILY_SECTION = Object.freeze({
  [REPORT_SECTION_IDS.TOPLINE]: DAILY_SECTION_KEYS.FINANCIAL,
  [REPORT_SECTION_IDS.BY_SOURCE]: DAILY_SECTION_KEYS.BY_SOURCE,
  [REPORT_SECTION_IDS.BY_AGENT]: DAILY_SECTION_KEYS.BY_AGENT,
  [REPORT_SECTION_IDS.STATUS]: DAILY_SECTION_KEYS.STATUS,
  // Actionable long-call rows remain separate from aggregate call statistics.
  [REPORT_SECTION_IDS.LONG_CALLS]: DAILY_SECTION_KEYS.CALL_HIGHLIGHTS,
});

const DAILY_TO_REPORT_SECTION = Object.freeze(
  Object.fromEntries(Object.entries(REPORT_TO_DAILY_SECTION).map(([report, daily]) => [daily, report])),
);

const TOPLINE_ADDITIVE_FIELDS = Object.freeze([
  "deals", "cash", "newCash", "recurring", "recurringExcluded",
  "spend", "mailSpend", "ldSpend", "mailCalls", "responses", "ldDials",
  "ldLeads", "ldLeadsBilled", "mailPieces", "dnc", "postdate", "suspended",
]);

const SOURCE_ROW_ADDITIVE_FIELDS = Object.freeze([
  "deals", "newCash", "recurringCash", "totalCash", "spend", "responses", "leads",
]);

const AGENT_SUMMARY_ADDITIVE_FIELDS = Object.freeze([
  "cases", "attempts", "attemptsKnown", "attemptsUnknown", "connected",
  "longCalls", "talkMinutes", "newInventory", "newInventoryUntouched",
  "newLeadsTouched", "worthHearingWithLink",
]);

const AGENT_ROW_ADDITIVE_FIELDS = Object.freeze([
  "inbound", "mailerIn", "bcdIn", "newLeads", "dials", "connected",
  "talkSec", "talkMinutes", "deals", "cash", "attributedMail",
  "attributedBcd", "attributedLd", "attributedSpend",
]);

const STATUS_ADDITIVE_FIELDS = Object.freeze([
  "dnc", "postdate", "suspended", "conversions", "other",
]);

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateKey(value) {
  const key = String(value || "");
  if (!DATE_KEY_RE.test(key)) return false;
  const parsed = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === key;
}

module.exports = {
  AGENT_ROW_ADDITIVE_FIELDS,
  AGENT_SUMMARY_ADDITIVE_FIELDS,
  AUXILIARY_DAILY_SECTION_KEYS,
  DAILY_SECTION_KEYS,
  DAILY_TO_REPORT_SECTION,
  REPORT_SECTION_IDS,
  REPORT_OWNED_DAILY_SECTION_KEYS,
  REPORT_TO_DAILY_SECTION,
  ROLLUP_SECTION_IDS,
  SOURCE_ROW_ADDITIVE_FIELDS,
  STATUS_ADDITIVE_FIELDS,
  TOPLINE_ADDITIVE_FIELDS,
  isValidDateKey,
};
