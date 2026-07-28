"use strict";

// The scheduler's two jobs it must never get wrong: resolve "yesterday" on the
// day it runs, and refuse to send the same report twice.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/reportDefinitionService");

// 2026-07-28 10:30 Pacific (17:30 UTC — same calendar day both sides).
const AT = new Date("2026-07-28T17:30:00Z");

test("rolling ranges resolve against the RUN date, never a frozen one", () => {
  assert.deepEqual(svc.resolveRange("today", AT), { from: "2026-07-28", to: "2026-07-28" });
  assert.deepEqual(svc.resolveRange("yesterday", AT), { from: "2026-07-27", to: "2026-07-27" });
  assert.deepEqual(svc.resolveRange("last7", AT), { from: "2026-07-21", to: "2026-07-27" });
  assert.deepEqual(svc.resolveRange("mtd", AT), { from: "2026-07-01", to: "2026-07-28" });
  assert.deepEqual(svc.resolveRange("lastmonth", AT), { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(svc.resolveRange("ytd", AT), { from: "2026-01-01", to: "2026-07-28" });
});

test("a UTC-evening run still reports the correct PACIFIC day", () => {
  // 2026-07-29 03:00 UTC is still 2026-07-28 in Pacific. A nightly report
  // fired at 8pm local must not jump a day.
  const evening = new Date("2026-07-29T03:00:00Z");
  assert.deepEqual(svc.resolveRange("today", evening), { from: "2026-07-28", to: "2026-07-28" });
  assert.deepEqual(svc.resolveRange("yesterday", evening), { from: "2026-07-27", to: "2026-07-27" });
});

const def = (o = {}) => ({
  name: "test", archivedAt: null,
  schedule: { enabled: true, hour: 7, minute: 0, daysOfWeek: [], daysOfMonth: [] },
  lastRunKey: null, ...o,
});

test("due only after the scheduled time", () => {
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, minute: 0 } }), AT).due, true);
  const later = svc.isDue(def({ schedule: { enabled: true, hour: 23, minute: 0 } }), AT);
  assert.equal(later.due, false);
  assert.equal(later.reason, "before scheduled time");
});

test("a restart cannot re-send a report that already went out", () => {
  // The whole reason lastRunKey is persisted rather than held in memory.
  const already = def({ lastRunKey: "2026-07-28" });
  const r = svc.isDue(already, AT);
  assert.equal(r.due, false);
  assert.equal(r.reason, "already ran today");
});

test("weekday and day-of-month restrictions are honoured", () => {
  // 2026-07-28 is a Tuesday (dayOfWeek 2).
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, daysOfWeek: [2] } }), AT).due, true);
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, daysOfWeek: [1, 3] } }), AT).due, false);
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, daysOfMonth: [28] } }), AT).due, true);
  assert.equal(svc.isDue(def({ schedule: { enabled: true, hour: 7, daysOfMonth: [1] } }), AT).due, false);
});

test("day-of-month 0 means the LAST day of the month", () => {
  const lastDay = new Date("2026-07-31T17:30:00Z");
  const d = def({ schedule: { enabled: true, hour: 7, daysOfMonth: [0] } });
  assert.equal(svc.isDue(d, lastDay).due, true);
  assert.equal(svc.isDue(d, AT).due, false, "the 28th is not the last day of July");
});

test("a disabled or archived definition is never due", () => {
  assert.equal(svc.isDue(def({ schedule: { enabled: false, hour: 7 } }), AT).due, false);
  assert.equal(svc.isDue(def({ archivedAt: new Date() }), AT).due, false);
});

test("an unknown block id fails LOUDLY instead of emailing a short report", async () => {
  await assert.rejects(
    () => svc.runDefinition(def({ blocks: ["money", "nonsense-block"] }), { dryRun: true }),
    /unknown block\(s\): nonsense-block/,
  );
});

test("sendMail is called (domain, options) — never options-first", () => {
  // mailerService.sendMail(domain, options). Passing the options object as the
  // first argument throws "`to` required" at send time, which means it fails
  // only in production, at 07:00, on the day someone is waiting for the email.
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  const calls = [...src.matchAll(/await sendMail\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, "expected a sendMail call to exist");
  for (const first of calls) {
    assert.ok(!first.startsWith("{"), `sendMail called options-first: sendMail(${first}...)`);
  }
});

test("a report definition never persists the ANSWER, only the shape", () => {
  // The doctrine in one assertion: we are a faceplate, not an aggregator.
  // A results/rows/sections field here would make the app an aggregator again.
  const schema = require("../../packages/shared-models/src/ReportDefinition").schema.obj;
  for (const banned of ["results", "rows", "sections", "data", "cache", "lastReport", "lastOutput"]) {
    assert.ok(!(banned in schema), `ReportDefinition must not store "${banned}" — reports re-gather every run`);
  }
  for (const required of ["blocks", "filters", "range", "schedule", "recipients"]) {
    assert.ok(required in schema, `ReportDefinition must store the shape field "${required}"`);
  }
});

test("runDefinition never passes a key composeReport ignores", () => {
  // Guard the whole class: an option name composeReport does not destructure
  // is silently discarded, which is invisible at runtime and looks correct.
  const fs = require("fs");
  const readBetween = (src, open, close, from = 0) => {
    const a = src.indexOf(open, from);
    if (a === -1) return null;
    const b = src.indexOf(close, a + open.length);
    return b === -1 ? null : src.slice(a + open.length, b);
  };

  const composerSrc = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportComposerService"), "utf8",
  );
  const sig = readBetween(composerSrc, "async function composeReport({", "}");
  assert.ok(sig, "could not read composeReport's signature");
  const accepted = sig.split(",").map((x) => x.split("=")[0].trim()).filter(Boolean);

  const defSrc = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportDefinitionService"), "utf8",
  );
  const call = readBetween(defSrc, "composeReport({", "});");
  assert.ok(call, "could not read the composeReport call site");
  const passed = call
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .flatMap((l) => l.split(","))
    .map((pair) => pair.split(":")[0].trim())
    .filter((k) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k));

  assert.ok(passed.includes("where"), "the call site must pass `where`");
  for (const key of passed) {
    assert.ok(accepted.includes(key), `composeReport ignores "${key}" — it is silently dropped`);
  }
});

test("an unspecified weekday/day-of-month list is EMPTY, not [0]", () => {
  // "".split(",") is [""], and Number("") is 0 — so an unspecified --dow
  // became [0] ("Sundays only") and --dom became [0] ("last day of month").
  // A daily 1pm report was silently scheduled for Sundays that fall on a
  // month end: roughly once a year, with nothing in the output to show it.
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../scripts/report-schedule.js"), "utf8",
  );
  const start = src.indexOf("const nums =");
  const body = src.slice(start, src.indexOf("function describe", start));
  assert.ok(body.includes(".filter(Boolean)"),
    "empty segments must be dropped BEFORE Number()");
  const idxFilter = body.indexOf(".filter(Boolean)");
  const idxNumber = body.indexOf(".map(Number)");
  assert.ok(idxFilter > 0 && idxNumber > idxFilter,
    "filter(Boolean) must come before map(Number)");
});

test("an empty schedule list means EVERY day, not one day", () => {
  // The semantics the parser must preserve: empty = unrestricted.
  const at = new Date("2026-07-28T20:30:00Z");     // Tue 13:30 PT
  const daily = {
    name: "x", archivedAt: null, lastRunKey: null,
    schedule: { enabled: true, hour: 13, minute: 0, daysOfWeek: [], daysOfMonth: [] },
  };
  assert.equal(svc.isDue(daily, at).due, true, "no restrictions means it runs");
  const sundaysOnly = {
    ...daily,
    schedule: { ...daily.schedule, daysOfWeek: [0], daysOfMonth: [0] },
  };
  assert.equal(svc.isDue(sundaysOnly, at).due, false,
    "[0]/[0] is Sunday AND month-end — the bug this guards");
});
