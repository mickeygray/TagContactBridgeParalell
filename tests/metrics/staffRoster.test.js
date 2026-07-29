"use strict";

// Who is on the sales floor, and who is not.
//
// Mickey 2026-07-28: "jon pineda owns the business and andrew sometimes picks
// up the phone but is cserv" — a board that ranks the OWNER at zero deals
// "would read as a mickey wtf are you doing".

const { test } = require("node:test");
const assert = require("node:assert/strict");

const roster = require("../../packages/shared-config/src/staffRoster");
const blocks = require("../../packages/shared-services/src/reportBlocksService");

test("the sales floor is exactly the five who write deals", () => {
  for (const name of ["Bruce Allen", "Phil Olson", "Chris Bolt", "Sean Lucas", "Brad Hansen"]) {
    assert.equal(roster.staffRole(name), roster.ROLES.SALES, name);
  }
  assert.equal(roster.staffRole("Jonathan Pineda"), roster.ROLES.OWNER);
  assert.equal(roster.staffRole("Andrew Wells"), roster.ROLES.CSERV);
});

test("name variants resolve to one person", () => {
  assert.equal(roster.canonicalStaffName("Jon Pineda"), "Jonathan Pineda");
  assert.equal(roster.staffRole("jon pineda"), roster.ROLES.OWNER, "case must not matter");
  assert.equal(roster.canonicalStaffName("  BRUCE   ALLEN "), "Bruce Allen");
});

test("an unknown name defaults to the sales floor and is VISIBLE", () => {
  // A new hire missing from the roster must still appear on the board.
  // Hiding unrecognised names would make the report quietly incomplete,
  // which is worse than an extra row that prompts a roster update.
  assert.equal(roster.staffRole("Brand New Hire"), roster.ROLES.SALES);
  assert.equal(roster.isUnknownStaff("Brand New Hire"), true);
  assert.equal(roster.isUnknownStaff("Bruce Allen"), false);
});

// ── how the work log uses it ─────────────────────────────────────────────

const MATERIAL = {
  queueByAgent: {
    "Bruce Allen": { MAILER: 25, LD: 26 },
    "Andrew Wells": { MAILER: 8, BCD: 1 },
    "Jonathan Pineda": { MAILER: 2 },
    "Brand New Hire": { MAILER: 4 },
  },
  queueStreams: { MAILER: { calls: 47, connected: 39, missed: 8 }, BCD: { calls: 1, connected: 1, missed: 0 } },
  payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 300, officerAtSale: "Bruce Allen", isChargeback: false }],
};

test("the OWNER is never named on a board that says we can see your work", () => {
  const d = blocks.BY_ID.get("worked").compute(MATERIAL);
  const named = [...d.rows, ...d.alsoAnswering].map((r) => r.agent);
  assert.ok(!named.includes("Jonathan Pineda"), "the owner must not be ranked or listed");
  assert.equal(d.offBoard.length, 1, "he is still tracked internally so the totals reconcile");
  const text = blocks.BY_ID.get("worked").renderText(d);
  assert.ok(!text.includes("Pineda"), "and must not appear anywhere in the rendered report");
});

test("customer service is CREDITED, separately, with no deals column", () => {
  const d = blocks.BY_ID.get("worked").compute(MATERIAL);
  assert.deepEqual(d.alsoAnswering.map((r) => r.agent), ["Andrew Wells"]);
  assert.ok(!d.rows.some((r) => r.agent === "Andrew Wells"), "cserv is not ranked against sales");
  const text = blocks.BY_ID.get("worked").renderText(d);
  assert.match(text, /Also answering \(customer service/);
  assert.match(text, /Andrew Wells — 9 taken/);
});

test("an unknown name lands on the sales board rather than disappearing", () => {
  const d = blocks.BY_ID.get("worked").compute(MATERIAL);
  assert.ok(d.rows.some((r) => r.agent === "Brand New Hire"));
});

test("the header and the table never quietly disagree", () => {
  // Calls taken by someone off the board are still queue facts. If the named
  // rows do not account for every connected call, the report says so.
  const d = blocks.BY_ID.get("worked").compute(MATERIAL);
  const text = blocks.BY_ID.get("worked").renderText(d);
  const named = [...d.rows, ...d.alsoAnswering].reduce((a, r) => a + r.taken, 0);
  assert.equal(named + d.offBoard.reduce((a, r) => a + r.taken, 0), d.totals.taken,
    "named + off-board must equal the queue's connected count");
  assert.match(text, /2 taken by someone off the sales board/);
});

test("a range with no call data shows — , never 0", () => {
  // Live 2026-07-01..28 rendered "Phil Olson 0 taken 0 made" for a month in
  // which he took 27 calls on the 27th alone. The note explaining it sat at
  // the bottom of the page, under a table the reader had already believed.
  const w = blocks.BY_ID.get("worked");
  const d = w.compute({
    queueByAgent: {}, queueStreams: {},
    queueUnavailable: "28 days exceeds QUEUE_DAY_LOOP_MAX (7)",
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 100, officerAtSale: "Phil Olson", isChargeback: false }],
  });
  const text = w.renderText(d);
  assert.match(text, /CALL DATA UNAVAILABLE/, "the gap must lead, not trail");
  assert.ok(text.indexOf("CALL DATA UNAVAILABLE") < text.indexOf("PERSON"),
    "the warning must appear ABOVE the table");
  const philLine = text.split(String.fromCharCode(10)).find((l) => l.startsWith("Phil Olson"));
  assert.ok(/—\s+—/.test(philLine), `counts must be em-dashes, got: ${philLine}`);
  assert.ok(!/\s0\s/.test(philLine), "must never print a zero it does not know");
  assert.match(philLine, /1/, "deals ARE known and must still show");
});

test("the CSV exports null, not 0, when calls were not measured", () => {
  // A spreadsheet will happily average a zero nobody told it to distrust.
  const w = blocks.BY_ID.get("worked");
  const d = w.compute({
    queueByAgent: {}, queueStreams: {}, queueUnavailable: "out of range",
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 100, officerAtSale: "Phil Olson", isChargeback: false }],
  });
  const csv = w.csv(d);
  const taken = csv.columns.find((c) => c.header === "calls_taken");
  const made = csv.columns.find((c) => c.header === "calls_made");
  const deals = csv.columns.find((c) => c.header === "deals_written");
  assert.equal(taken.get(csv.rows[0]), null);
  assert.equal(made.get(csv.rows[0]), null);
  assert.equal(deals.get(csv.rows[0]), 1, "deals are measured and must survive");
});

test("with real queue data the counts come back", () => {
  const w = blocks.BY_ID.get("worked");
  const d = w.compute({
    queueByAgent: { "Phil Olson": { MAILER: 27, LD: 79 } },
    queueStreams: { MAILER: { calls: 30, connected: 27, missed: 3 } },
    payments: [],
  });
  const text = w.renderText(d);
  assert.ok(!text.includes("UNAVAILABLE"));
  assert.match(text, /Phil Olson\s+27\s+79/);
});
