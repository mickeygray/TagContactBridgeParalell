"use strict";

// WHERE A RECOVERY CASE SITS IN THE LINE.
//
// Mickey 2026-07-31, exactly: "below brand new 0 contact but above same day
// 1 contact until it gets contacted."
//
// Three clauses, and all three matter:
//
//   "below brand new 0 contact"  — a lead nobody has ever called still wins
//   "above same day 1 contact"   — but a SECOND dial does not
//   "until it gets contacted"    — and the elevation ends at the first attempt
//
// The last clause is the one that keeps this honest. The priority is earned by
// an unanswered fifteen-minute conversation, not by program membership — so the
// moment the episode has been dialled it competes on the same terms as every
// other retry. Without that, one recovery case would hold the front of the line
// all day on the strength of a call it already received.
//
// This is deliberately a RANKING lens, not a pool change: membership stays four
// pools (the parent contract's law), and a recovery case remains ordinary
// `older_available` work everywhere except the moment of selection.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSelectionRank,
  compareSelectionCandidates,
} = require("../../packages/shared-services/src/leadDeliveryService");

const NOW = new Date("2026-08-03T18:00:00Z");
const ago = (n) => new Date(NOW.getTime() - n * 86400000);

const item = (over = {}) => ({
  domain: "TAG", caseId: "x", sourcePool: "older_available", receivedAt: ago(300),
  totalAttemptCount: 0, lastContactAt: null, ...over,
});
const RECOVERY = (over = {}) => item({
  inventoryClass: "callrail_long_call_recovery",
  contactPolicyId: "long_call_recovery_120d_2x",
  ...over,
});

const rank = (i) => resolveSelectionRank(i, { now: NOW });

test("a brand-new untouched lead outranks an uncontacted recovery case", () => {
  const virgin = item({ caseId: "new", sourcePool: "new_today", receivedAt: NOW });
  const recovery = RECOVERY({ caseId: "rec" });
  assert.ok(rank(virgin) < rank(recovery), "0-contact new must win");
});

test("an uncontacted recovery case outranks anything already contacted today", () => {
  const recovery = RECOVERY({ caseId: "rec" });
  // A lead that arrived this morning and has already had one dial.
  const touchedNew = item({
    caseId: "new-1x", sourcePool: "new_today", receivedAt: NOW,
    totalAttemptCount: 1, lastContactAt: new Date(NOW.getTime() - 3600000),
  });
  // And a retry that is due.
  const retry = item({
    caseId: "retry", sourcePool: "follow_up_due", totalAttemptCount: 1,
    lastContactAt: new Date(NOW.getTime() - 7200000),
    nextContactAt: new Date(NOW.getTime() - 60000),
  });
  assert.ok(rank(recovery) < rank(touchedNew), "a second dial does not beat a first conversation");
  assert.ok(rank(recovery) < rank(retry), "nor does a due retry");
});

test("the elevation ENDS the moment the recovery case is contacted", () => {
  // The whole point of "until it gets contacted".
  const uncontacted = RECOVERY({ caseId: "rec" });
  const contacted = RECOVERY({
    caseId: "rec", totalAttemptCount: 1, lastContactAt: new Date(NOW.getTime() - 3600000),
  });
  assert.ok(rank(uncontacted) < rank(contacted), "one dial gives up the front of the line");

  const retry = item({
    caseId: "retry", sourcePool: "follow_up_due", totalAttemptCount: 1,
    lastContactAt: new Date(NOW.getTime() - 7200000), nextContactAt: NOW,
  });
  assert.equal(rank(contacted), rank(retry), "afterwards it competes on the same terms as any retry");
});

test("touched work is spread by fewest prior attempts before due-time age", () => {
  const once = item({
    caseId: "once", sourcePool: "follow_up_due", totalAttemptCount: 1,
    lastContactAt: new Date(NOW.getTime() - 3600000),
    nextContactAt: new Date(NOW.getTime() - 60000),
  });
  const heavilyRecycled = item({
    caseId: "many", sourcePool: "follow_up_due", totalAttemptCount: 12,
    lastContactAt: ago(30), nextContactAt: ago(20),
  });

  assert.ok(compareSelectionCandidates(once, heavilyRecycled, { now: NOW }) < 0,
    "a lead awaiting attempt two must beat a lead awaiting attempt thirteen");
});

test("due time still orders leads inside the same attempt band", () => {
  const olderDue = item({
    caseId: "older-due", sourcePool: "follow_up_due", totalAttemptCount: 2,
    lastContactAt: ago(2), nextContactAt: ago(1),
  });
  const newerDue = item({
    caseId: "newer-due", sourcePool: "follow_up_due", totalAttemptCount: 2,
    lastContactAt: ago(1), nextContactAt: new Date(NOW.getTime() - 60000),
  });

  assert.ok(compareSelectionCandidates(olderDue, newerDue, { now: NOW }) < 0,
    "overdue age remains the tie-breaker when attempt counts match");
});

test("10-14 touch work favors newer leads over older ones", () => {
  const olderTen = item({
    caseId: "older-ten", totalAttemptCount: 10, receivedAt: ago(90),
    lastContactAt: ago(1), nextContactAt: new Date(NOW.getTime() - 60000),
  });
  const newerFourteen = item({
    caseId: "newer-fourteen", totalAttemptCount: 14, receivedAt: ago(5),
    lastContactAt: ago(1), nextContactAt: new Date(NOW.getTime() - 60000),
  });

  assert.ok(compareSelectionCandidates(newerFourteen, olderTen, { now: NOW }) < 0,
    "lead age, not the small attempt-count difference, orders the 10-14 band");
});

test("15 touches enters the phase-out tier behind ordinary retries", () => {
  const fourteen = item({
    caseId: "fourteen", totalAttemptCount: 14, receivedAt: ago(30),
    lastContactAt: ago(1), nextContactAt: ago(1),
  });
  const fifteen = item({
    caseId: "fifteen", totalAttemptCount: 15, receivedAt: ago(1),
    lastContactAt: ago(20), nextContactAt: ago(5),
  });

  assert.ok(rank(fourteen) < rank(fifteen));
  assert.ok(compareSelectionCandidates(fourteen, fifteen, { now: NOW }) < 0);
});

test("lastContactAt alone ends the elevation, even with a zero counter", () => {
  // A counter that failed to increment must not silently re-grant priority.
  const ghost = RECOVERY({ totalAttemptCount: 0, lastContactAt: new Date(NOW.getTime() - 600000) });
  assert.ok(rank(ghost) > rank(RECOVERY()), "evidence of contact beats the counter");
});

test("recovery never bypasses the overnight first-contact barrier", () => {
  // §16 is explicit, and it outranks Mickey's ordering preference because
  // overnight is a first-contact guarantee, not a priority tier.
  const overnight = item({ caseId: "on", sourcePool: "overnight", overnightOrder: 1 });
  assert.ok(rank(overnight) < rank(RECOVERY()), "overnight stays on top");
});

test("all zero-touch aged work shares the pre-retry priority band", () => {
  const aged = item({ caseId: "aged", sourcePool: "older_available", receivedAt: ago(400) });
  assert.equal(rank(RECOVERY()), rank(aged));
  assert.ok(compareSelectionCandidates(RECOVERY(), aged, { now: NOW }) < 0);
});

test("the whole line sorts in Mickey's stated order", () => {
  // One assertion that reads like the sentence he said.
  const line = [
    item({ caseId: "aged", sourcePool: "older_available", receivedAt: ago(400) }),
    item({ caseId: "retry-due", sourcePool: "follow_up_due", totalAttemptCount: 1,
      lastContactAt: new Date(NOW.getTime() - 7200000), nextContactAt: NOW }),
    RECOVERY({ caseId: "recovery-uncontacted" }),
    item({ caseId: "brand-new", sourcePool: "new_today", receivedAt: NOW }),
    item({ caseId: "overnight", sourcePool: "overnight", overnightOrder: 1 }),
  ];
  const sorted = [...line].sort((a, b) => compareSelectionCandidates(a, b, { now: NOW }));
  assert.deepEqual(sorted.map((i) => i.caseId), [
    "overnight",
    "brand-new",
    "recovery-uncontacted",
    "aged",
    "retry-due",
  ]);
});

test("ties inside a tier still use the pool's own ordering", () => {
  // The rank is a lens on top of the existing comparators, not a replacement —
  // two recovery cases still order by the recovery rules underneath.
  const a = RECOVERY({ caseId: "A", receivedAt: ago(300), lastContactAt: null });
  const b = RECOVERY({ caseId: "B", receivedAt: ago(300), lastContactAt: null });
  assert.equal(rank(a), rank(b));
  const sorted = [b, a].sort((x, y) => compareSelectionCandidates(x, y, { now: NOW }));
  assert.equal(sorted.length, 2, "a stable tie-break must still produce an order");
});

test("mail recovery is capped at 2 a day — it never reaches the 3/day band", () => {
  // Mickey: "i do think 3 times a day is a little much for mail." The cap is
  // decided by contactPolicyId BEFORE age is consulted, so no recovery case can
  // ever inherit the 0-1 day ordinary allowance.
  const { resolveLeadDeliveryContactPolicy } = require(
    "../../packages/shared-services/src/leadDeliveryService");
  const freshest = resolveLeadDeliveryContactPolicy({
    inventoryClass: "callrail_long_call_recovery",
    contactPolicyId: "long_call_recovery_120d_2x",
    receivedAt: new Date(NOW.getTime() - 3600000),
    eligibleFrom: new Date(NOW.getTime() - 60000),
    expiresAt: new Date(NOW.getTime() + 119 * 86400000),
  }, { now: NOW });
  assert.equal(freshest.maximumDailyAttempts, 2);

  const ordinaryBrandNew = resolveLeadDeliveryContactPolicy({ receivedAt: NOW }, { now: NOW });
  assert.equal(ordinaryBrandNew.maximumDailyAttempts, 3, "ordinary fresh LD keeps its 3");
});

// ── the comparator has to be a VALID total order ──────────────────────────
//
// The first version was not. Within a tier it used the pool's comparator when
// two items shared a pool and a stable id otherwise — two different orderings
// inside one tier, which breaks transitivity. A brute force over 1320 triples
// found 36 violations, e.g.
//
//   aaa/follow_up_due < mmm/new_today < zzz/follow_up_due
//   yet aaa > zzz
//
// because the outer pair fell to a different rule than the inner ones.
// Array.prototype.sort with an inconsistent comparator is implementation-
// defined, so the line an agent gets handed could differ between runs with
// nothing in the data changing. That is the worst kind of ordering bug to
// chase, and it is cheap to make impossible — so this test brute-forces it.

test("compareSelectionCandidates is a valid total order", () => {
  const { compareSelectionCandidates: cmpFn } = require(
    "../../packages/shared-services/src/leadDeliveryService");
  const cmp = (a, b) => cmpFn(a, b, { now: NOW });

  const pools = ["follow_up_due", "new_today", "older_available", "overnight"];
  const items = [];
  for (const id of ["aaa", "mmm", "zzz"]) {
    for (const pool of pools) {
      for (const touched of [0, 1]) {
        const c = id.charCodeAt(0);
        items.push({
          domain: "TAG", caseId: `${id}:${pool}:${touched}`, sourcePool: pool,
          totalAttemptCount: touched,
          lastContactAt: touched ? new Date(NOW.getTime() - 3600000 - c * 1000) : null,
          nextContactAt: new Date(NOW.getTime() - c * 10000),
          receivedAt: new Date(NOW.getTime() - c * 100000),
          expiresAt: new Date(NOW.getTime() + c * 100000),
          firstQualifyingCallAt: new Date(NOW.getTime() - c * 200000),
          overnightOrder: c % 5,
          // half the aged bucket is recovery, so tier 2 is populated too
          inventoryClass: pool === "older_available" && c % 2 === 0
            ? "callrail_long_call_recovery" : null,
        });
      }
    }
  }

  let asymmetry = 0;
  let intransitive = 0;
  for (const a of items) {
    for (const b of items) {
      if (a === b) continue;
      if (Math.sign(cmp(a, b)) !== -Math.sign(cmp(b, a))) asymmetry += 1;
      for (const c of items) {
        if (b === c || a === c) continue;
        if (cmp(a, b) < 0 && cmp(b, c) < 0 && !(cmp(a, c) < 0)) intransitive += 1;
      }
    }
  }
  assert.equal(asymmetry, 0, "cmp(a,b) must be the negation of cmp(b,a)");
  assert.equal(intransitive, 0, "a<b and b<c must imply a<c");
});

test("sorting is deterministic regardless of input order", () => {
  // The observable consequence of the bug above: shuffle the input, get a
  // different line. This is the assertion an operator would actually feel.
  const { compareSelectionCandidates: cmpFn } = require(
    "../../packages/shared-services/src/leadDeliveryService");
  const line = [
    item({ caseId: "aged", sourcePool: "older_available", receivedAt: ago(400) }),
    item({ caseId: "retry-a", sourcePool: "follow_up_due", totalAttemptCount: 1,
      lastContactAt: ago(1), nextContactAt: new Date(NOW.getTime() - 60000) }),
    item({ caseId: "retry-b", sourcePool: "new_today", totalAttemptCount: 1,
      lastContactAt: ago(1), nextContactAt: new Date(NOW.getTime() - 120000) }),
    RECOVERY({ caseId: "rec", expiresAt: new Date(NOW.getTime() + 5 * 86400000) }),
    item({ caseId: "brand-new", sourcePool: "new_today", receivedAt: NOW }),
  ];
  const sortOf = (arr) => [...arr].sort((a, b) => cmpFn(a, b, { now: NOW })).map((i) => i.caseId);
  const expected = sortOf(line);
  for (const shuffle of [
    [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2], [3, 2, 1, 0, 4],
  ]) {
    assert.deepEqual(sortOf(shuffle.map((i) => line[i])), expected,
      "the same set must always produce the same line");
  }
});

test("a recovery item survives the LeadDeliveryItem schema with its policy intact", () => {
  // The schema is STRICT. Before these fields existed, mongoose dropped
  // inventoryClass / contactPolicyId / expiresAt / eligibleFrom on write, so a
  // recovery item came back out of Mongo indistinguishable from ordinary aged
  // filler. The dangerous half was not the cap — an unrecognised item falls
  // back to the age policy, which is stricter for an old case — it was the
  // EXPIRY: with expiresAt gone there is no 120-day stop, and the episode would
  // never age out of the program it is only allowed to run for 120 days.
  const LeadDeliveryItem = require("../../packages/shared-models/src/LeadDeliveryItem");
  const ld = require("../../packages/shared-services/src/leadDeliveryService");

  const doc = new LeadDeliveryItem({
    domain: "TAG", caseId: "421385", normalizedPhone: "7249674387",
    sourcePool: "older_available", receivedAt: ago(300),
    inventoryClass: "callrail_long_call_recovery",
    contactPolicyId: "long_call_recovery_120d_2x",
    eligibleFrom: ago(1),
    expiresAt: new Date(NOW.getTime() + 60 * 86400000),
    episodeId: "callrail-mail-long-call-v1:TAG:421385:1",
    firstQualifyingCallAt: ago(60),
  }).toObject();

  for (const field of [
    "inventoryClass", "contactPolicyId", "expiresAt", "eligibleFrom", "episodeId",
  ]) {
    assert.ok(doc[field] != null, `${field} was dropped by the schema`);
  }

  const policy = ld.resolveLeadDeliveryContactPolicy(doc, { now: NOW });
  assert.equal(policy.contactPolicyId, "long_call_recovery_120d_2x");
  assert.equal(policy.maximumDailyAttempts, 2, "not the ordinary age cap");
  assert.equal(policy.minimumRetryMinutes, 120);
  assert.equal(resolveSelectionRank(doc, { now: NOW }), 2, "and it still ranks as recovery");
});

test("the 120-day stop is actually enforceable on a persisted item", () => {
  const LeadDeliveryItem = require("../../packages/shared-models/src/LeadDeliveryItem");
  const ld = require("../../packages/shared-services/src/leadDeliveryService");
  const expired = new LeadDeliveryItem({
    domain: "TAG", caseId: "1", normalizedPhone: "7249674387",
    sourcePool: "older_available", receivedAt: ago(300),
    inventoryClass: "callrail_long_call_recovery",
    contactPolicyId: "long_call_recovery_120d_2x",
    eligibleFrom: ago(121), expiresAt: ago(1),
  }).toObject();
  const policy = ld.resolveLeadDeliveryContactPolicy(expired, { now: NOW });
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, "recovery-expired");
});
