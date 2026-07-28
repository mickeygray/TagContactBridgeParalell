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
