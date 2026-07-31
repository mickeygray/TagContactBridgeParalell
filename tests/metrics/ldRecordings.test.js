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

const run = (dials, events = [], ldCaseStatus = {}) => blocks.BY_ID.get("ldrecordings").compute({ dials, events, ldCaseStatus });

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

test("the email shows what decides whether to press play", () => {
  // `outcome` joined the set once the case id gave us the case's real status;
  // before that the column would only ever have read "review".
  const csv = blocks.BY_ID.get("ldrecordings").csv(run([dial({
    attempts: [attempt({ recordingUrl: "https://media.example.com/r/1.mp3" })],
  })]));
  assert.deepEqual(csv.emailColumns.map((c) => c.header),
    ["minutes", "agent", "case", "outcome", "listen"]);
  // and the full set still reaches the CSV attachment
  assert.ok(csv.columns.length > csv.emailColumns.length);
});

test("it reads dials, the activity sweep and live case status — never CallRail", () => {
  // CallRail is a single TAG tenant of INBOUND calls and can never be split by
  // company, so it must not source an LD list. `activity` gives the agent from
  // the case id; `ldCaseStatus` gives where the case stands NOW, which is what
  // puts a status on every row rather than only the ones that moved.
  const needs = blocks.BY_ID.get("ldrecordings").needs;
  assert.deepEqual(needs, ["dials", "activity", "ldCaseStatus"]);
  assert.ok(!needs.includes("callsRange"));
});

test("both boards carry it, and it is the vendor board's only call list", () => {
  assert.ok(blocks.PRESETS["vendor-ld"].includes("ldrecordings"));
  assert.ok(blocks.PRESETS.rollup.includes("ldrecordings"));
});

// Mickey 2026-07-31: "crm case id is how to get agent and outcome from
// activities." The case id is the join and the sweep is already in memory, so
// both come without a single extra Logics call.

const ev = (over = {}) => ({
  domain: "WYNN", caseId: 430083, kind: "status-change",
  createdAt: "2026-07-31T10:00:00Z", payload: {}, ...over,
});

test("the outcome is the case's latest status, not the lead-state token", () => {
  // attempts.outcome only ever holds "review" or "dnc" — that is lead state,
  // not what came of the conversation.
  const rows = run(
    [dial({ attempts: [attempt({ outcome: "review" })] })],
    [ev({ payload: { toStatus: "[Active Prospect]-POST DATE" } })],
  );
  assert.equal(rows[0].outcome, "[Active Prospect]-POST DATE");
});

test("the latest status wins when a case moved twice", () => {
  const rows = run([dial({ attempts: [attempt()] })], [
    ev({ createdAt: "2026-07-31T09:00:00Z", payload: { toStatus: "[Active Prospect]-Opened" } }),
    ev({ createdAt: "2026-07-31T17:00:00Z", payload: { toStatus: "[TIER 1]-ACTIVE" } }),
  ]);
  assert.equal(rows[0].outcome, "[TIER 1]-ACTIVE");
});

test("with no status change, review reports as no outcome rather than a meaningless word", () => {
  const rows = run([dial({ attempts: [attempt({ outcome: "review" })] })], []);
  assert.equal(rows[0].outcome, null, "review is the ABSENCE of a disposition");
});

test("dnc survives the fallback — it is a real result", () => {
  const rows = run([dial({ attempts: [attempt({ outcome: "dnc" })] })], []);
  assert.equal(rows[0].outcome, "DNC");
});

test("the agent is the case's settlement officer, with the dialling seat behind it", () => {
  const rows = run([dial({ attempts: [attempt({ agentId: "phil_olson" })] })], [
    ev({ kind: "assignment", subject: "Assigned to Set. Officer : Chris Bolt" }),
  ]);
  assert.equal(rows[0].agent, "Chris Bolt", "the officer owns the case");
  assert.equal(rows[0].agentSeat, "Phil Olson", "the seat that dialled is kept");
});

test("--Unassigned-- is never printed as a person", () => {
  const rows = run([dial({ attempts: [attempt({ agentId: "phil_olson" })] })], [
    ev({ kind: "assignment", subject: "Assigned to Set. Officer : --Unassigned--" }),
  ]);
  assert.equal(rows[0].agent, "Phil Olson", "falls back to the seat, not to the placeholder");
});

test("activity for a different case never bleeds across", () => {
  const rows = run([dial({ caseId: 430083, attempts: [attempt()] })], [
    ev({ caseId: 999999, payload: { toStatus: "[TIER 1]-ACTIVE" } }),
  ]);
  assert.equal(rows[0].outcome, null);
});

// Mickey 2026-07-31: "there should be a case status in every one of those calls
// like you have for mailer." The inbound side pulls the case live; LD was
// reading status-change ACTIVITY, which only answers for cases that moved
// inside the window — 8 of 66 in July. The other 58 showed nothing, and a blank
// reads as a gap rather than as "nothing happened".

test("the live case status wins over a status change inside the window", () => {
  // The sweep says where a case MOVED; the live read says where it STANDS.
  // A case can post-date on Tuesday and be active by Friday.
  const rows = run(
    [dial({ attempts: [attempt()] })],
    [ev({ payload: { toStatus: "[Active Prospect]-POST DATE" } })],
    { "WYNN:430083": "[TIER 1]-ACTIVE" },
  );
  assert.equal(rows[0].outcome, "[TIER 1]-ACTIVE");
});

test("the sweep still answers when the live read could not", () => {
  // One unreadable case must not blank the row when the window knows better.
  const rows = run(
    [dial({ attempts: [attempt()] })],
    [ev({ payload: { toStatus: "[Active Prospect]-POST DATE" } })],
    {},
  );
  assert.equal(rows[0].outcome, "[Active Prospect]-POST DATE");
});

test("every long dial carries a status when the live read answered", () => {
  const rows = run(
    [dial({ caseId: 1, attempts: [attempt()] }), dial({ caseId: 2, attempts: [attempt()] })],
    [],
    { "WYNN:1": "[TIER 1]-ACTIVE", "WYNN:2": "[Bad/Inactive]-DO NOT CALL" },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.every((r) => r.outcome), true, "a blank status reads as a gap");
});

test("status for another case never bleeds across", () => {
  const rows = run([dial({ caseId: 430083, attempts: [attempt()] })], [], { "WYNN:999999": "[TIER 1]-ACTIVE" });
  assert.equal(rows[0].outcome, null);
});
