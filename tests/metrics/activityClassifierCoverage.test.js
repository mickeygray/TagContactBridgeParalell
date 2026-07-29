"use strict";

// The prose-drift guard.
//
// ActivitySubject is free text — staff type into it — so a regex written
// against one spelling silently misses the rest, and the miss is invisible:
// the row still parses, it just lands in `note`, and whatever counted on it
// reports a smaller number with total confidence.
//
// Every string below was taken verbatim from a real July 2026 pull, and each
// one was ACTUALLY BEING MISSED before these patterns were widened. Measure
// drift again any time with:
//
//   node scripts/classify-coverage.js --probe "soft ?pull"

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyRow } = require("../../packages/shared-services/src/activityEventService");

const row = (ActivitySubject, Type = "General") => ({
  __domain: "TAG", CaseID: "1", Type, Created: "2026-07-15T10:00:00Z",
  CreatedBy: "Phil Olson", ActivitySubject,
});

// ── soft pull: eight spellings of one concept ────────────────────────────
const SOFT_PULLS = [
  ["iSoftpull TransUnion Score: 648 (Raymond)", 648, "TransUnion"],
  ["ISOFTPULL TRANSUNION SCORE: (VINCENT) 728", 728, "TransUnion"],
  ["Isoftpull Transunion (RAYMOND) 644", 644, "TransUnion"],
  ["iSoftpull TransUnion Score:801 (Michele )", 801, "TransUnion"],
  ["SOFT PULL 615 KERI VANDERHOF", 615, null],
  ["SOFT PULL VANESSA SWIGART 701", 701, null],
  ["SOFTPULL-VINCENT-636", 636, null],
  ["PER SOFTPULL FICO SCORE 652", 652, null],
  ["SOFT PULL AKRA DANIEL (690)", 690, null],
  ["Credit Score - 706", 706, null],
  ["Credit Score: 477 Exp", 477, "Experian"],
];

for (const [subject, score, bureau] of SOFT_PULLS) {
  test(`soft pull recognised: ${subject.slice(0, 44)}`, () => {
    const { kind, payload } = classifyRow(row(subject));
    assert.equal(kind, "credit-score", `fell through to "${kind}"`);
    assert.equal(payload.score, score);
    assert.equal(payload.bureau, bureau);
    assert.equal(payload.noScore, false);
  });
}

test("a reported 0 is NO SCORE, not a score of zero", () => {
  // 13 July rows read "Score: 0". Averaging them in drags the mean 42 points.
  const { kind, payload } = classifyRow(row("iSoftpull TransUnion Score: 0 (ERWIN)"));
  assert.equal(kind, "credit-score");
  assert.equal(payload.score, null, "0 must never be reported as a credit score");
  assert.equal(payload.noScore, true);
  assert.equal(payload.reason, "no-score-returned");
});

test("a frozen report says so", () => {
  const { payload } = classifyRow(row("iSoftpull TransUnion Score: FROZEN"));
  assert.equal(payload.score, null);
  assert.equal(payload.reason, "frozen");
});

test("bureau is canonical, not as-typed", () => {
  // TransUnion arrived three ways in one month. Title-casing the raw match
  // just reproduces the alias split in a tidier font.
  const spellings = ["Transunion", "TRANSUNION", "TransUnion"];
  const got = spellings.map((b) => classifyRow(row(`iSoftpull ${b} Score: 700`)).payload.bureau);
  assert.deepEqual(new Set(got), new Set(["TransUnion"]), `got ${JSON.stringify(got)}`);
});

test("a name or phone in the subject is not mistaken for a score", () => {
  const { payload } = classifyRow(row("SOFT PULL roberto "));
  assert.equal(payload.score, null);
  assert.equal(payload.noScore, true);
});

test("soft pulls typed General are still soft pulls", () => {
  // 80 of 184 July soft pulls carried Type "General" — filtering on Type
  // alone finds 104 of 184.
  assert.equal(classifyRow(row("SOFT PULL 633 (JAKE MINES)", "General")).kind, "credit-score");
  assert.equal(classifyRow(row("SOFT PULL 633 (JAKE MINES)", "1SOFTPULL")).kind, "credit-score");
  assert.equal(classifyRow(row("SOFT PULL 633 (JAKE MINES)", "iSoft Pull")).kind, "credit-score");
});

// ── status changes: quoted AND unquoted ──────────────────────────────────
test("quoted status change parses", () => {
  const { kind, payload } = classifyRow(
    row('Status changed from "[Active Prospect]-Opened" to "[Bad/Inactive]-DO NOT CALL"'),
  );
  assert.equal(kind, "status-change");
  assert.equal(payload.safetyClass, "dnc");
  assert.equal(payload.toStatus, "[Bad/Inactive]-DO NOT CALL");
});

test("UNQUOTED status change parses — and keeps its safety class", () => {
  // 20 of 548 July status rows arrive unquoted, and they are not a random
  // 20: they are DO NOT CALL and Disconnected Number. A missed DNC is the
  // one status this system must never lose.
  const { kind, payload } = classifyRow(
    row("Status changed from [Active Prospect]-Opened to [Bad/Inactive] - [Bad/Inactive]-DO NOT CALL"),
  );
  assert.equal(kind, "status-change", `fell through to "${kind}"`);
  assert.equal(payload.safetyClass, "dnc", "the duplicated bracket must not swallow the class");
  assert.equal(payload.toStatus, "[Bad/Inactive]-DO NOT CALL");
});

test("unquoted disconnected-number transition parses", () => {
  const { kind, payload } = classifyRow(
    row("Status changed from [Active Prospect]-Opened to [Bad/Inactive] - [Bad/Inactive]-Disconnected Number"),
  );
  assert.equal(kind, "status-change");
  assert.equal(payload.toLabel, "Disconnected Number");
});

test("a self-transition is flagged, not counted as news", () => {
  const { payload } = classifyRow(
    row('Status changed from "[TIER 1]-ACTIVE" to "[TIER 1]-ACTIVE"'),
  );
  assert.equal(payload.selfTransition, true);
});

// ── the lanes that must NOT be confused ──────────────────────────────────
test("lead ingestion stays system-lane, not staff work", () => {
  // 68.9% of all rows. If these counted as staff activity, one API service
  // account would be 81% of the company's work.
  const { kind, staff, payload } = classifyRow(row("Case received from ABC"));
  assert.equal(kind, "intake");
  assert.equal(staff, false);
  assert.equal(payload.source, "ABC");
});

test("a Public API echo is never interpreted as work", () => {
  const { kind, staff } = classifyRow(row("Case updated by Public API"));
  assert.equal(kind, "system-echo");
  assert.equal(staff, false);
});
