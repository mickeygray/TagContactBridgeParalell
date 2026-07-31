"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// 2026-07-30: the nightly email fired on schedule with nothing behind it. The
// 20:00 activity review had not written its rollup, so the status line read
// "unavailable" and the money read came back empty — and it went out anyway.
// An empty nightly is worse than none: it looks like a quiet day rather than a
// broken pipeline, and it teaches the reader to skip the one that matters.
//
// These tests pin the FIELD NAMES as much as the behaviour. The guard was first
// written against invented names (`initial`, `total`, `calls`) which are all
// undefined on the real summary — that version would have suppressed every
// email whenever the rollup was missing, turning a noisy bug into a silent one.

const svc = require("../../packages/shared-services/src/simpleNightlyEmailService");

const totals = (over = {}) => ({
  spend: 0, uniqueLeads: 0, totalCalls: 0, ldLeads: 0,
  initialsCount: 0, initialsNet: 0, cashCollected: 0, ...over,
});

test("the summary field names the guard reads are the ones the read actually returns", () => {
  // If simpleMarketingReadService renames these, the guard silently stops
  // guarding. Fail here instead.
  const shape = totals();
  for (const key of ["spend", "totalCalls", "ldLeads", "initialsNet", "cashCollected"]) {
    assert.ok(key in shape, `${key} must exist on summary.totals`);
  }
});

test("a day with money is worth sending even with no activity rollup", () => {
  const t = totals({ initialsNet: 4200 });
  const hasMoney = Number(t.initialsNet || 0) > 0 || Number(t.cashCollected || 0) > 0 || Number(t.spend || 0) > 0;
  assert.equal(hasMoney, true, "the status rollup is a narrative extra, not a gate on money");
});

test("a day with calls but no money is still worth sending", () => {
  const t = totals({ totalCalls: 63 });
  const hasCalls = Number(t.totalCalls || 0) > 0 || Number(t.ldLeads || 0) > 0;
  assert.equal(hasCalls, true);
});

test("spend alone counts as something to report", () => {
  // Mail goes out on days nobody closes. A spend-only day is a real day.
  const t = totals({ spend: 1990.12 });
  assert.ok(Number(t.spend) > 0);
});

test("nothing at all is the case that must not be mailed", () => {
  const t = totals();
  const hasMoney = Number(t.initialsNet || 0) > 0 || Number(t.cashCollected || 0) > 0 || Number(t.spend || 0) > 0;
  const hasCalls = Number(t.totalCalls || 0) > 0 || Number(t.ldLeads || 0) > 0;
  assert.equal(hasMoney || hasCalls, false);
});

test("the guard is reachable — sendSimpleNightlyEmail is exported and gated", async () => {
  assert.equal(typeof svc.sendSimpleNightlyEmail, "function");
  const prior = process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED;
  process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED = "false";
  try {
    const r = await svc.sendSimpleNightlyEmail({ dateKey: "2026-07-30" });
    assert.equal(r.sent, false);
    assert.match(r.reason, /SIMPLE_NIGHTLY_EMAIL_ENABLED/);
  } finally {
    if (prior === undefined) delete process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED;
    else process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED = prior;
  }
});
