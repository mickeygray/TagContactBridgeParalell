"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

// Mickey 2026-07-31: "identify the person who took the call, the link and the
// case and bring it to the ld report but also to noteable recordings."
//
// Recordings now arrive on the PhoneBurner call callback and land on the
// DailyDial attempt. Three earlier explanations for their absence were all
// wrong — sessions "cannot be enumerated", "we never asked", a 15-minute
// generation delay. The real reason was that the service account 404s on
// getDialSession for the agents' own sessions, so the callback is the only
// path and the capture is what had to be fixed.

const dial = (over = {}) => ({
  domain: "wynn", caseId: 430083, dateKey: "2026-07-31", lastOutcome: "review",
  attempts: [], ...over,
});
const attempt = (over = {}) => ({
  agentId: "phil_olson", durationSeconds: 900, connected: true, outcome: "review", ...over,
});

const run = (dials) => blocks.BY_ID.get("ldrecordings").compute({ dials });

test("a long dial is reported with the agent, the case and the link", () => {
  const rows = run([dial({
    attempts: [attempt({ recordingUrl: "https://media.example.com/r/1.mp3" })],
  })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "Phil Olson", "the seat id is canonicalised to the person");
  assert.equal(rows[0].caseId, 430083);
  assert.equal(rows[0].domain, "WYNN");
  assert.equal(rows[0].listenUrl, "https://media.example.com/r/1.mp3");
  assert.equal(rows[0].minutes, 15);
});

test("a call with no recording yet is still listed, marked pending", () => {
  // The recording lands after the call ends, so "not yet" is the normal state.
  // Dropping the row would understate the day and hide a real conversation.
  const rows = run([dial({ attempts: [attempt({ recordingUrl: null })] })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listenUrl, null);
  const csv = blocks.BY_ID.get("ldrecordings").csv(rows);
  assert.match(csv.summary, /pending/);
});

test("a doc-level recording is used when the attempt has none", () => {
  // The call-log projection writes one at the document level too.
  const rows = run([dial({
    recordingUrl: "https://media.example.com/doc.mp3",
    attempts: [attempt({ recordingUrl: null })],
  })]);
  assert.equal(rows[0].listenUrl, "https://media.example.com/doc.mp3");
});

test("short dials are excluded — a link with no conversation behind it is noise", () => {
  assert.equal(run([dial({ attempts: [attempt({ durationSeconds: 45 })] })]).length, 0);
});

test("calls are ordered longest first", () => {
  const rows = run([dial({
    attempts: [attempt({ durationSeconds: 400 }), attempt({ durationSeconds: 1200 })],
  })]);
  assert.deepEqual(rows.map((r) => r.minutes), [20, 6.7]);
});

test("an unknown seat is named as unknown rather than dropped", () => {
  const rows = run([dial({ attempts: [attempt({ agentId: null })] })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "(unknown)");
});

test("the email shows the four things that decide whether to press play", () => {
  const csv = blocks.BY_ID.get("ldrecordings").csv(run([dial({
    attempts: [attempt({ recordingUrl: "https://media.example.com/r/1.mp3" })],
  })]));
  assert.deepEqual(csv.emailColumns.map((c) => c.header), ["minutes", "agent", "case", "listen"]);
  // and the full set still reaches the CSV attachment
  assert.ok(csv.columns.length > csv.emailColumns.length);
});

test("it reads dials only — never CallRail, which cannot be split by company", () => {
  assert.deepEqual(blocks.BY_ID.get("ldrecordings").needs, ["dials"]);
  assert.ok(!blocks.BY_ID.get("ldrecordings").needs.includes("callsRange"));
});

test("both boards carry it, and it is the vendor board's only call list", () => {
  assert.ok(blocks.PRESETS["vendor-ld"].includes("ldrecordings"));
  assert.ok(blocks.PRESETS.rollup.includes("ldrecordings"));
});
