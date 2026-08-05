"use strict";

// Confirming a range's movers against what is true right now.
// Mickey 2026-08-05: "you check the month, get 100 cases, run get-case-by-id,
// look at its status and record it as its status as of right now."

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  confirmStatusNow, splitConfirmed,
} = require("../../packages/shared-services/src/statusConfirmService");

const facadeWith = (byCase, calls = []) => () => ({
  fetchCaseInfo: async (caseId) => {
    calls.push(caseId);
    const v = byCase[caseId];
    if (v instanceof Error) throw v;
    return v ?? null;
  },
});

test("each case is read ONCE even when it moved in two lanes", async () => {
  // The status is a property of the case, not of the lane it moved in.
  const calls = [];
  const r = await confirmStatusNow({
    cases: [
      { domain: "TAG", caseId: 500, lane: "dnc" },
      { domain: "TAG", caseId: 500, lane: "suspended" },
      { domain: "TAG", caseId: 501, lane: "dnc" },
    ],
    facadeFor: facadeWith({ 500: { StatusID: 39 }, 501: { StatusID: 2 } }, calls),
  });
  assert.deepEqual(calls.sort(), [500, 501], "500 read once, not twice");
  assert.equal(r.checked, 2);
  const five = r.rows.find((x) => x.caseId === 500);
  assert.deepEqual(five.lanes.sort(), ["dnc", "suspended"], "but both lanes are remembered");
});

test("a case we could NOT read is unreadable, never cleared", async () => {
  // Dropping it would turn a Logics outage into a suspiciously clean board.
  const r = await confirmStatusNow({
    cases: [{ domain: "TAG", caseId: 1, lane: "dnc" }, { domain: "TAG", caseId: 2, lane: "dnc" }],
    facadeFor: facadeWith({ 1: new Error("Logics 504"), 2: { StatusID: 39 } }),
  });
  assert.equal(r.unreadable, 1);
  const bad = r.rows.find((x) => x.caseId === 1);
  assert.equal(bad.unreadable, true);
  assert.equal(bad.statusNow, null);
  assert.match(bad.reason, /Logics 504/);

  // And it lands in its own bucket — neither outstanding nor cleared.
  const split = splitConfirmed(r.rows, (row) => row.statusIdNow === 39);
  assert.equal(split.unknown.length, 1);
  assert.equal(split.outstanding.length, 1);
  assert.equal(split.cleared.length, 0);
});

test("a case whose status moved on is CLEARED; one that held is outstanding", async () => {
  const r = await confirmStatusNow({
    cases: [
      { domain: "TAG", caseId: 10, lane: "dnc" },   // still DNC
      { domain: "TAG", caseId: 11, lane: "dnc" },   // worked since
    ],
    facadeFor: facadeWith({ 10: { StatusID: 39 }, 11: { StatusID: 2 } }),
  });
  const split = splitConfirmed(r.rows, (row) => row.statusIdNow === 39);
  assert.deepEqual(split.outstanding.map((x) => x.caseId), [10]);
  assert.deepEqual(split.cleared.map((x) => x.caseId), [11]);
});

test("an empty candidate list does no work at all", async () => {
  const calls = [];
  const r = await confirmStatusNow({ cases: [], facadeFor: facadeWith({}, calls) });
  assert.equal(calls.length, 0);
  assert.equal(r.checked, 0);
  assert.deepEqual(r.rows, []);
});

test("the answer is stamped as of NOW, because that is the only thing it claims", async () => {
  const before = Date.now();
  const r = await confirmStatusNow({
    cases: [{ domain: "TAG", caseId: 1, lane: "dnc" }],
    facadeFor: facadeWith({ 1: { StatusID: 39 } }),
  });
  assert.ok(r.asOf instanceof Date);
  assert.ok(r.asOf.getTime() >= before);
});

test("cases are grouped per domain, and each domain gets its own facade", async () => {
  const built = [];
  const r = await confirmStatusNow({
    cases: [
      { domain: "TAG", caseId: 1, lane: "dnc" },
      { domain: "WYNN", caseId: 2, lane: "dnc" },
      { domain: "WYNN", caseId: 3, lane: "dnc" },
    ],
    facadeFor: (domain) => { built.push(domain); return { fetchCaseInfo: async () => ({ StatusID: 39 }) }; },
  });
  assert.deepEqual(built.sort(), ["TAG", "WYNN"], "one facade per domain, not per case");
  assert.equal(r.byDomain.WYNN.checked, 2);
  assert.equal(r.byDomain.TAG.checked, 1);
});
