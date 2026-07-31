"use strict";

// THE NIGHTLY EMAIL'S SAFETY PROPERTIES.
//
// Mickey 2026-07-31: "make sure to harden the whole process so it runs
// automatically at 8 pm every night, its the only metrics process that runs."
//
// Everything here exists because of one incident: a nightly email went out for
// WEEKS reading zero. Nobody noticed, because every layer degraded politely —
// a gather failed, returned empty, a block rendered 0, the mail looked like a
// quiet day, and the run filed as a success. There was no single bug to fix;
// there was a chain in which no link could say "I could not read this."
//
// So these tests pin the ability to SAY SO, at every link:
//   composer  — a failed source lands on `failures`, benign telemetry does not
//   blocks    — "0 dials" and "unreadable dials" render differently
//   template  — failures reach the reader ABOVE the numbers
//   delivery  — a run that mailed nothing cannot record itself as delivered
//   schedule  — a broken definition stops re-gathering all night
//
// The field names below are pinned deliberately. A previous empty-guard was
// written against INVENTED names (`initial`, `total`, `calls`) and would have
// suppressed every email; it was caught by reading the real return shape. If
// one of these assertions fails because a field was renamed, the guard that
// depends on it has already stopped working — fix both.

const test = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");
const composer = require("../../packages/shared-services/src/reportComposerService");
const svc = require("../../packages/shared-services/src/reportDefinitionService");

// ── blocks: a broken gather must not look like a quiet day ────────────────

const ldcallsData = (over = {}) => ({
  dialsUnavailable: null, queueUnavailable: null,
  cases: 0, attempts: 0, connected: 0, longCalls: 0,
  attemptsKnown: 0, attemptsUnknown: 0, talkMinutes: 0,
  connectRate: null, avgTalkMinutes: null, byOutcome: {},
  agents: [{ agent: "Chris Bolt", inbound: 0, dials: 0, connected: 0, talkMinutes: 0, deals: 1, cash: 700 }],
  longThresholdMinutes: 5, worthHearing: [], worthHearingWithLink: 0,
  ...over,
});

test("an unreadable dial gather does NOT render as zero dials", () => {
  // The exact string the old code emailed on a total PhoneBurner outage:
  // "0 dials · no connect data · 0 min talk" — indistinguishable from a
  // Saturday.
  const quiet = blocks.BY_ID.get("ldcalls").csv(ldcallsData());
  assert.match(quiet.summary, /^0 dials/, "a genuinely idle range still reads as zero");

  const broken = blocks.BY_ID.get("ldcalls").csv(ldcallsData({ dialsUnavailable: "ECONNREFUSED" }));
  assert.match(broken.summary, /DIAL DATA UNAVAILABLE/);
  assert.match(broken.summary, /ECONNREFUSED/, "say WHICH source, so it can be chased");
  assert.match(broken.summary, /[Dd]eals and cash below are complete/,
    "the half that still works must be named, or the whole board gets distrusted");
});

test("unreadable dial counts print as dashes, but deals and cash stay real", () => {
  const table = blocks.BY_ID.get("ldcalls").csv(ldcallsData({ dialsUnavailable: "timeout" }));
  const row = table.rows[0];
  const cell = (h) => table.emailColumns.find((c) => c.header === h).get(row);
  assert.equal(cell("dials"), "—");
  assert.equal(cell("connected"), "—");
  assert.equal(cell("talk_minutes"), "—");
  assert.equal(cell("deals"), 1, "deals come from payments — a dial outage does not touch them");
  assert.equal(cell("cash"), 700);
});

test("the CSV keeps raw numbers even when the email shows dashes", () => {
  // A dash is a reading aid for a person. A spreadsheet should never have to
  // parse one.
  const table = blocks.BY_ID.get("ldcalls").csv(ldcallsData({ dialsUnavailable: "timeout", queueUnavailable: "429" }));
  const raw = (h) => table.columns.find((c) => c.header === h).get(table.rows[0]);
  assert.equal(raw("dials"), 0);
  assert.equal(raw("inbound"), 0);
});

test("an unreadable queue keeps the inbound column and dashes it", () => {
  // The column is dropped when a board legitimately has no inbound (a vendor
  // board). An OUTAGE is the opposite case and must not borrow that treatment,
  // or a RingCentral failure reads as "this board has no inbound".
  const gone = blocks.BY_ID.get("ldcalls").csv(ldcallsData());
  assert.equal(gone.emailColumns.some((c) => c.header === "inbound"), false);

  const broken = blocks.BY_ID.get("ldcalls").csv(ldcallsData({ queueUnavailable: "rate limited" }));
  const col = broken.emailColumns.find((c) => c.header === "inbound");
  assert.ok(col, "an outage must not silently remove the column");
  assert.equal(col.get(broken.rows[0]), "—");
});

test("a CallRail outage does not let the call section say 'Nothing in this range'", () => {
  const longcalls = blocks.BY_ID.get("longcalls");
  const material = {
    callsRange: [], payments: [], callRecordings: {}, callContext: {},
    dials: [], events: [], ldCaseStatus: {}, ldCaseSource: {},
    from: "2026-07-30", to: "2026-07-30", domain: null,
  };
  const quiet = longcalls.compute(material);
  assert.equal(longcalls.csv(quiet).summary, undefined, "a genuinely quiet day stays quiet");

  const broken = longcalls.compute({ ...material, callsRangeUnavailable: "CallRail 503 on 3 of 46 day(s)" });
  assert.match(longcalls.csv(broken).summary, /INBOUND CALLS INCOMPLETE/);
  assert.match(longcalls.csv(broken).summary, /Outbound LD calls below are complete/);
});

test("a vendor board does not claim incomplete inbound it was never going to show", () => {
  // CallRail is excluded from a WYNN board by design. Reporting the outage
  // there would be a false alarm, and false alarms are how a banner gets
  // ignored.
  const longcalls = blocks.BY_ID.get("longcalls");
  const rows = longcalls.compute({
    callsRange: [], payments: [], callRecordings: {}, callContext: {},
    dials: [], events: [], ldCaseStatus: {}, ldCaseSource: {},
    from: "2026-07-30", to: "2026-07-30", domain: "WYNN",
    callsRangeUnavailable: "CallRail 503",
  });
  assert.equal(longcalls.csv(rows).summary, undefined);
});

// ── template data: failures reach the reader, telemetry does not ──────────

const reportWith = (failures, notes = []) => ({
  from: "2026-07-30", to: "2026-07-30", domain: "ALL",
  failures, notes, sections: [], filters: [],
});

test("gather failures reach the email as `alerts`", () => {
  const data = composer.toTemplateData(reportWith(["dials unavailable — ECONNREFUSED"]));
  assert.deepEqual(data.alerts, ["dials unavailable — ECONNREFUSED"],
    "this is the field report.hbs renders — renaming it silently empties the banner");
});

test("a clean night carries an EMPTY alerts array, not a missing one", () => {
  // `{{#if alerts.length}}` must evaluate, not throw past a missing key.
  const data = composer.toTemplateData(reportWith([]));
  assert.ok(Array.isArray(data.alerts));
  assert.equal(data.alerts.length, 0);
});

test("benign telemetry stays OUT of the email", () => {
  // The ruling that notes are operator telemetry was right and stands. The bug
  // was that failures rode in the same array, so honouring the ruling dropped
  // both. A banner that fires every night is a banner nobody reads.
  const data = composer.toTemplateData(reportWith([], [
    "121 payment(s) have no attribution snapshot yet",
    "response feed synced from CallRail for 2026-07-30..2026-07-30",
    "call detail is CallRail (TAG tenant) only",
  ]));
  assert.equal(data.alerts.length, 0, "routine notes must never reach the banner");
});

test("the template renders the banner above the sections", async () => {
  // Position is the point: a warning under the numbers is read after the
  // reader has already believed them.
  const mailer = require("../../packages/shared-services/src/mailerService");
  const render = mailer.renderTemplate || mailer.renderOnly;
  const html = render("reports/report", composer.toTemplateData({
    ...reportWith(["queue counts unavailable — 429 from RingCentral"]),
    sections: [{ id: "x", label: "Top line", data: {}, block: { csv: () => ({ summary: "all good", rows: [], columns: [] }) } }],
  }));
  assert.match(html, /A source did not answer/);
  assert.match(html, /429 from RingCentral/);
  assert.ok(html.indexOf("429 from RingCentral") < html.indexOf("Top line"),
    "the warning must come BEFORE the numbers it is about");
});

// ── the schedule: a broken definition must not run all night ──────────────

const AT = new Date("2026-07-28T17:30:00Z"); // Tue 10:30 Pacific

const def = (o = {}) => ({
  name: "test", archivedAt: null,
  schedule: { enabled: true, hour: 7, minute: 0, daysOfWeek: [], daysOfMonth: [] },
  lastRunKey: null, ...o,
});

test("three failed attempts and it waits for tomorrow", () => {
  // Every attempt is a FULL live gather: a CallRail daily-stat re-sync that
  // WRITES to Mongo, ~46 per-day CallRail pulls, a Logics getCaseInfo per
  // deal, RingCentral queue paging. Left uncapped between 20:30 and midnight
  // that is hundreds of rounds against three vendors — which is how a bad
  // Tuesday makes Wednesday wrong too.
  const key = "2026-07-28";
  assert.equal(svc.isDue(def({ lastAttemptKey: key, attemptsToday: 2 }), AT).due, true);
  const capped = svc.isDue(def({ lastAttemptKey: key, attemptsToday: 3 }), AT);
  assert.equal(capped.due, false);
  assert.match(capped.reason, /not retrying until tomorrow/);
});

test("yesterday's failures do not count against today", () => {
  const stale = svc.isDue(def({ lastAttemptKey: "2026-07-27", attemptsToday: 9 }), AT);
  assert.equal(stale.due, true, "the counter is per-day, keyed — not a running total");
});

test("a failed attempt is never mistaken for a delivered run", () => {
  // lastRunKey means "it went out". lastAttemptKey means "we tried". Keeping
  // them separate is what lets a retry happen at all.
  const tried = def({ lastAttemptKey: "2026-07-28", attemptsToday: 1, lastRunKey: null });
  assert.equal(svc.isDue(tried, AT).due, true);
  const sent = def({ lastRunKey: "2026-07-28" });
  assert.equal(svc.isDue(sent, AT).reason, "already ran today");
});

test("Monday-to-Friday actually excludes the weekend", () => {
  // The operator asked for M-F. An EMPTY daysOfWeek means every day, which is
  // what both write paths default to — so this is a config value that has to
  // be set, not a capability that has to be built.
  const weekdays = { enabled: true, hour: 7, minute: 0, daysOfWeek: [1, 2, 3, 4, 5] };
  const sat = new Date("2026-08-01T17:30:00Z"); // Saturday
  const sun = new Date("2026-08-02T17:30:00Z"); // Sunday
  assert.equal(svc.isDue(def({ schedule: weekdays }), AT).due, true, "Tuesday runs");
  assert.equal(svc.isDue(def({ schedule: weekdays }), sat).due, false);
  assert.equal(svc.isDue(def({ schedule: weekdays }), sun).due, false);

  // And the trap: empty is NOT weekdays.
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, minute: 0, daysOfWeek: [] } }), sat).due,
    true, "empty daysOfWeek means EVERY day — the reason it has to be set explicitly");
});

// ── failures vs advisories: only one of them is an alarm ──────────────────
//
// Caught in a dry run of the real 8pm boards on 2026-07-31: BOTH marked
// themselves [DEGRADED], because the spend sheet had no rows for that day. It
// never does — the sheet is hand-maintained and normally runs two or three days
// behind, so as first written every nightly would have carried the word
// DEGRADED. Within a week that word means nothing, which is the same way the
// original silent-zero incident stayed invisible.

test("a cap we chose is shown but is NOT a degraded board", () => {
  const data = composer.toTemplateData({
    ...reportWith([]),
    advisories: ["15 long call(s) left without a listen link (fetch cap 25)"],
  });
  assert.equal(data.failures.length, 0, "nothing is broken — we chose to stop fetching");
  assert.equal(data.advisories.length, 1);
  assert.equal(data.alerts.length, 1, "the reader still has to know why the column is blank");
});

test("a real outage and a lagging sheet render as different bands", async () => {
  const mailer = require("../../packages/shared-services/src/mailerService");
  const render = mailer.renderTemplate || mailer.renderOnly;
  const html = render("reports/report", composer.toTemplateData({
    ...reportWith(["dials unavailable — ECONNREFUSED"]),
    advisories: ["15 long call(s) left without a listen link (fetch cap 25)"],
  }));
  assert.match(html, /A source did not answer/);
  assert.match(html, /ECONNREFUSED/);
  assert.match(html, /left without a listen link/);
  assert.match(html, /#fef2f2/, "failures render red");
  assert.match(html, /#fffbeb/, "advisories render amber");
});

test("only a real failure sets the DEGRADED subject", () => {
  // runDefinition reads report.failures, NOT report.alerts, for the prefix.
  // Pinned here because the two are one keystroke apart and the difference is
  // whether every nightly cries wolf.
  const advisoryOnly = composer.toTemplateData({ ...reportWith([]), advisories: ["recordings skipped — cap"] });
  assert.equal(advisoryOnly.failures.length, 0);
  const broken = composer.toTemplateData(reportWith(["queue counts unavailable — 429"]));
  assert.equal(broken.failures.length, 1);
});
