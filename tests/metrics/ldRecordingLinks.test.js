"use strict";

// LD RECORDING LINKS — PhoneBurner reads DailyDial, RingCentral reads CallLog.
//
// Mickey 2026-08-03: "lets just keep them separate let call log be the
// recording for ring central and daily dial for phone burner instead of trying
// to blend them."
//
// Why DailyDial for PhoneBurner: CallLog holds 21,038 phoneburner rows and
// ZERO carrying a recording, all time — the old reader required
// recordingArchive.sourceUri, so it could never return a listen link no matter
// what arrived. Measured 2026-08-03, today's 403 recording-carrying calls had
// zero CallLog rows and 403/403 matching DailyDial attempts.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

const recordings = () => blocks.BY_ID.get("recordings");

// A PhoneBurner row as the DailyDial reader shapes it: no caller, no phone.
const dialRow = (over = {}) => ({
  platform: "phoneburner",
  caseId: "137564",
  domain: "WYNN",
  agent: "phil_olson",
  providerCallId: "pb-1",
  durationSec: 618,
  minutes: 10.3,
  listenUrl: "http://recordings.example.com/a",
  reasons: ["LONG"],
  ...over,
});

// A CallRail row: inbound, so it HAS a caller and no agent.
const callrailRow = (over = {}) => ({
  platform: "callrail",
  callId: "cr-1",
  caller: "Inbound Caller",
  phone: "5550001111",
  durationSec: 700,
  minutes: 11.7,
  listenUrl: "https://callrail.example.com/b",
  reasons: ["LONG"],
  ...over,
});

const cells = (row) => {
  const t = recordings().csv([row]);
  return Object.fromEntries(t.columns.map((c) => [c.header, c.get(row)]));
};

test("a PhoneBurner dial carries its listen link into the email columns", () => {
  const c = cells(dialRow());
  assert.equal(c.listen_url, "http://recordings.example.com/a");
  assert.equal(c.platform, "phoneburner");
  assert.equal(c.case_id, "137564");
});

test("an outbound dial is identified by AGENT, not by a caller it never had", () => {
  // The column previously produced `undefined` on every dial row, because a
  // dial has no caller. undefined reaches a template as a hole.
  const c = cells(dialRow());
  assert.equal(c.agent, "phil_olson");
  assert.equal(c.caller, null, "an outbound dial has no caller — null, not undefined");
});

test("NO cell is ever undefined — a hole renders unpredictably", () => {
  // Both shapes, and a deliberately threadbare row.
  for (const row of [dialRow(), callrailRow(), { platform: "phoneburner", reasons: [] }]) {
    const t = recordings().csv([row]);
    for (const col of t.columns) {
      assert.notEqual(col.get(row), undefined, `${col.header} must be null, never undefined`);
    }
  }
});

test("an inbound CallRail row still reads by caller", () => {
  const c = cells(callrailRow());
  assert.equal(c.caller, "Inbound Caller");
  assert.equal(c.agent, null, "an inbound call has no dialling agent");
  assert.equal(c.listen_url, "https://callrail.example.com/b");
});

test("the rendered text names the agent and case for a dial, never \"?\"", () => {
  const text = recordings().renderText([dialRow()]);
  assert.match(text, /phil_olson/);
  assert.match(text, /case 137564/);
  assert.equal(/\?/.test(text), false, "a dial is not missing data — it is outbound");
});

test("a call with no recording says so instead of showing an empty link", () => {
  // Pre-cutoff calls genuinely have none. "no link" and a blank link must not
  // look the same — this stack keeps shipping confident blanks.
  const text = recordings().renderText([dialRow({ listenUrl: null })]);
  assert.match(text, /\(no link\)/);
  assert.equal(cells(dialRow({ listenUrl: null })).listen_url, null);
});

test("both platforms coexist in one section without either being dropped", () => {
  const rows = [dialRow(), callrailRow()];
  const t = recordings().csv(rows);
  assert.equal(t.rows.length, 2);
  const platforms = rows.map((r) => t.columns.find((c) => c.header === "platform").get(r));
  assert.deepEqual(platforms.sort(), ["callrail", "phoneburner"]);
});

// ── THE LISTEN LIST ONLY LISTS LISTENABLE CALLS ───────────────────────────
//
// Mickey 2026-08-03: "i kinda wanna do a filter if we dont have a url dont
// include in calls to listen to."
//
// The section exists to press play, and most rows are currently linkless —
// recording capture only began 2026-08-03T20:57:45Z. But the COUNT is kept:
// dropping them silently would make a day where recordings failed look
// identical to a quiet day.

const longcalls = () => blocks.BY_ID.get("longcalls");

const call = (over = {}) => ({
  dateKey: "2026-08-03", minutes: 12, source: "LD CUSTOM", outcome: "no outcome yet",
  officer: "Phil Olson", caseId: 1, listenUrl: "http://rec.example.com/a", ...over,
});

test("a call with no recording is not offered to listen to", () => {
  const t = longcalls().csv([call(), call({ caseId: 2, listenUrl: null })]);
  assert.equal(t.emailRows.length, 1);
  assert.equal(t.emailRows[0].caseId, 1);
});

test("but the count is REPORTED — a failed capture is not a quiet day", () => {
  const t = longcalls().csv([call(), call({ caseId: 2, listenUrl: null })]);
  assert.match(String(t.summary), /1 long call not listed/);
  assert.match(String(t.summary), /no recording/);
});

test("every call still reaches the CSV, link or not", () => {
  const t = longcalls().csv([call(), call({ caseId: 2, listenUrl: null })]);
  assert.equal(t.rows.length, 2, "the CSV is where the full record lives");
});

test("a clean day says nothing extra", () => {
  const t = longcalls().csv([call(), call({ caseId: 2 })]);
  assert.equal(t.emailRows.length, 2);
  assert.equal(t.summary, undefined, "no filler line when nothing was dropped");
});

test("an unreadable CallRail still wins the summary line", () => {
  // A source outage matters more than a missing recording — it must not be
  // displaced by the drop count.
  const rows = [call({ listenUrl: null })];
  rows.unavailable = "callrail 503";
  const t = longcalls().csv(rows);
  assert.match(String(t.summary), /INBOUND CALLS INCOMPLETE/);
});

test("a day where NOTHING has a recording lists nothing and says why", () => {
  const t = longcalls().csv([call({ listenUrl: null }), call({ caseId: 2, listenUrl: null })]);
  assert.equal(t.emailRows.length, 0);
  assert.match(String(t.summary), /2 long calls not listed/);
});
