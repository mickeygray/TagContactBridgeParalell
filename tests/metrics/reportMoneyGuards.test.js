"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  balanceCheck, claimOnce, groupComplete, netChargebacks,
} = require("../../packages/shared-services/src/reportMoneyGuards");

// Each of these is a mistake that was actually made on 2026-07-30 and produced
// a number that looked right. The comments name the real figure so nobody
// "simplifies" the guard away later.

test("a chargeback comes off recurring before it can touch an initial", () => {
  // July 2026: netting the whole month's -$10,197 against initials invented a
  // $9,197 hole in new business. Six of the seven reversals were payment plans
  // on older clients and had nothing to do with this month's sales.
  const r = netChargebacks({ initial: 0, recurring: 9391, chargeback: -4247.32 });
  assert.equal(r.recurringNet, 5143.68);
  assert.equal(r.initialNet, 0, "an initial must not absorb a recurring reversal");
  assert.equal(r.unapplied, 0);
});

test("a reversal reaches the initial only once recurring is exhausted", () => {
  // Case 409586: $1,000 initial in, $1,000 straight back out, no recurring.
  // This is the one July chargeback that genuinely cancels new business.
  const r = netChargebacks({ initial: 1000, recurring: 0, chargeback: -1000 });
  assert.equal(r.initialNet, 0);
  assert.equal(r.recurringNet, 0);
  assert.equal(r.unapplied, 0);
});

test("a reversal bigger than the range is reported, not swallowed", () => {
  // The original payment landed in an earlier month, so this range shows money
  // leaving that it never showed arriving. Silently clamping it to zero hides
  // a real cash movement.
  const r = netChargebacks({ initial: 200, recurring: 100, chargeback: -1000 });
  assert.equal(r.recurringNet, 0);
  assert.equal(r.initialNet, 0);
  assert.equal(r.unapplied, 700);
});

test("a blank grouping key sends the row to a residual bucket, never to nowhere", () => {
  // payment.sourceAtSale is empty on ~35% of cases. Filtering mail on it lost
  // $10,258.80 of a $40,710.84 month, and the report looked complete.
  const rows = [
    { case: 1, source: "Urgent Third State", amount: 100 },
    { case: 2, source: "", amount: 250 },
    { case: 3, source: null, amount: 400 },
  ];
  const { groups, residual, total } = groupComplete(rows, (r) => r.source);
  assert.equal(total, 3);
  assert.equal(residual.length, 2);
  const counted = [...groups.values()].reduce((s, g) => s + g.length, 0);
  assert.equal(counted, rows.length, "every row must land in exactly one bucket");
  assert.ok(groups.has("(unattributed)"));
  const money = [...groups.values()].flat().reduce((s, r) => s + r.amount, 0);
  assert.equal(money, 750, "no money may be lost to a blank key");
});

test("a case belongs to exactly one owner, by a stated rule", () => {
  // Crediting a case to whoever called about it put one case on two agents and
  // inflated the month by $1,000. Longest call wins, and it is written down.
  const claims = [
    { caseId: "500", agent: "Phil Olson", minutes: 12 },
    { caseId: "500", agent: "Bruce Allen", minutes: 41 },
    { caseId: "501", agent: "Sean Lucas", minutes: 5 },
  ];
  const owned = claimOnce(claims, {
    caseOf: (c) => c.caseId, ownerOf: (c) => c.agent, scoreOf: (c) => c.minutes,
  });
  assert.equal(owned.size, 2);
  assert.equal(owned.get("500").owner, "Bruce Allen");
  assert.equal(owned.get("501").owner, "Sean Lucas");
});

test("claiming ignores rows with no case or no owner rather than inventing one", () => {
  const owned = claimOnce([
    { caseId: "", agent: "Phil Olson", minutes: 30 },
    { caseId: "600", agent: null, minutes: 30 },
  ], { caseOf: (c) => c.caseId, ownerOf: (c) => c.agent, scoreOf: (c) => c.minutes });
  assert.equal(owned.size, 0);
});

test("balanceCheck stays silent when the parts equal the whole", () => {
  assert.equal(balanceCheck([16650.85, 8626.99, 5200, 1750, 9483], 41710.84, "initials"), null);
});

test("balanceCheck says so, in print, when they do not", () => {
  // The per-agent columns summed $1,000 over the real total for a whole
  // evening because nothing ever compared them.
  const note = balanceCheck([21800.55, 8014.49, 4720.83, 500], 34035.87, "initials");
  assert.ok(note, "a report that cannot balance must say so");
  assert.match(note, /does not balance/);
  assert.match(note, /\+1000\.00/);
});
