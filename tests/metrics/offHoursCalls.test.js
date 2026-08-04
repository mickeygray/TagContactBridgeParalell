"use strict";

// THE CALL-BACK SHEET.
//
// Mickey 2026-08-04: a morning email to settlement officers "about where to
// clean up some money including red lines and overnight calls".
//
// Measured 2026-08-01..02: 31 inbound calls, 19 of them FIRST-TIME callers,
// every one carrying a callback number — and no board reported any of it,
// because none runs at a weekend. Those people raised their hand and then sat
// through Monday untouched.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

const blk = () => blocks.BY_ID.get("offhourscalls");
const RANGE = { from: "2026-08-01", to: "2026-08-03" };

const call = (over = {}) => ({
  callId: 1, phone: "5550001111", source: "Urgent Third State",
  startedAt: "2026-08-01T18:00:00Z", durationSec: 300, dateKey: "2026-08-01",
  firstCall: true, answered: true, ...over,
});

const rowsOf = (calls, range = RANGE) => blk().compute({ callsRange: calls, ...range });

test("a weekend first-time caller is listed", () => {
  // 2026-08-01T18:00Z = Sat 11:00 Pacific.
  const rows = rowsOf([call()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weekend, true);
  assert.equal(rows[0].phone, "5550001111");
});

test("a weeknight caller is listed too — it is off-HOURS, not just weekends", () => {
  // 2026-08-04T02:00Z = Mon 19:00 Pacific.
  const rows = rowsOf([call({ startedAt: "2026-08-04T02:00:00Z", dateKey: "2026-08-03" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weekend, false);
  assert.match(rows[0].when, /Mon 19:00/);
});

test("a caller during working hours is NOT listed", () => {
  // 2026-08-03T19:00Z = Mon 12:00 Pacific — somebody was on the phones.
  assert.equal(rowsOf([call({ startedAt: "2026-08-03T19:00:00Z", dateKey: "2026-08-03" })]).length, 0);
});

test("a REPEAT caller is excluded — they are already in a follow-up", () => {
  // Listing them turns a call-back sheet into a call log nobody actions.
  assert.equal(rowsOf([call({ firstCall: false })]).length, 0);
  assert.equal(rowsOf([call({ firstCall: null })]).length, 0, "unknown is not first-time");
});

test("the 45-day lookback does NOT leak into the sheet", () => {
  // callsRange deliberately reaches back so call-to-close lag is not clipped.
  // Without the range filter a call-back sheet carries a month of stale
  // callers and nobody works any of it.
  const old = call({ startedAt: "2026-07-01T19:00:00Z", dateKey: "2026-07-01" });
  assert.equal(rowsOf([old]).length, 0);
});

test("the DATE is the Pacific day the call happened, not the day it was fetched", () => {
  // 2026-08-03T04:00Z is Sunday 2026-08-02 21:00 Pacific but is fetched under
  // 08-03. Pairing the fetch date with the Pacific weekday printed
  // "2026-08-03 Sun" — a date and a day-name that contradict each other on a
  // sheet somebody is meant to work from.
  const rows = rowsOf([call({ startedAt: "2026-08-03T04:00:00Z", dateKey: "2026-08-03" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateKey, "2026-08-02");
  assert.match(rows[0].when, /Sun/);
  assert.equal(rows[0].fetchedUnder, "2026-08-03", "the fetch day is kept for tracing");
});

test("an unanswered call is called out — it is the most urgent row", () => {
  const rows = rowsOf([call({ answered: false })]);
  const t = blk().csv(rows);
  assert.match(String(t.summary), /1 went unanswered/);
});

test("an unreadable feed is NOT a quiet weekend", () => {
  const rows = blk().compute({ callsRange: [], callsRangeUnavailable: "callrail 503", ...RANGE });
  const t = blk().csv(rows);
  assert.match(String(t.summary), /CALL FEED INCOMPLETE/);
  assert.equal(/first-time caller/.test(String(t.summary)), false);
});

test("a genuinely quiet range says nothing at all", () => {
  const t = blk().csv(rowsOf([]));
  assert.equal(t.summary, undefined, "no filler line on a clean range");
});

test("the phone is the deliverable — it is a call-back sheet", () => {
  const t = blk().csv(rowsOf([call()]));
  assert.deepEqual(t.emailColumns.map((c) => c.header), ["when", "piece", "call back", "mins"]);
  assert.equal(t.emailColumns.find((c) => c.header === "call back").get(rowsOf([call()])[0]), "5550001111");
});

test("oldest first — the coldest lead goes stale soonest", () => {
  const rows = rowsOf([
    call({ callId: 2, startedAt: "2026-08-04T02:00:00Z", dateKey: "2026-08-03" }),
    call({ callId: 1, startedAt: "2026-08-01T18:00:00Z", dateKey: "2026-08-01" }),
  ]);
  assert.equal(rows[0].dateKey, "2026-08-01");
});
