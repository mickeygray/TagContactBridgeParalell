"use strict";

// LD spend materializer — the pure parts. Run:
//   node --test tests/metrics/ldSpendService.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getLdRates,
  computeLdSpendEntries,
  findLdCollisions,
} = require("../../packages/shared-services/src/ldSpendService");

test("rates: general $1.50, custom/custom-2/custom-3 $3 by default; env overrides", () => {
  const rates = getLdRates();
  assert.equal(rates["ld-general"], 1.5);
  assert.equal(rates["ld-custom"], 3);
  assert.equal(rates["ld-custom-2"], 3);
  assert.equal(rates["ld-custom-3"], 3);

  process.env.LD_GENERAL_COST_PER_LEAD = "1.75";
  try {
    assert.equal(getLdRates()["ld-general"], 1.75);
  } finally {
    delete process.env.LD_GENERAL_COST_PER_LEAD;
  }
});

test("computeLdSpendEntries: count × rate per family, zero-lead days emit $0 rows", () => {
  const entries = computeLdSpendEntries({
    domain: "wynn",
    dateKey: "2026-06-11",
    families: [
      { family: "ld-general", leads: 40 },
      { family: "ld-custom", leads: 10 },
      { family: "mail", leads: 99 }, // not LD — ignored
      // ld-custom-2 absent → zero row
    ],
  });
  const byKey = Object.fromEntries(entries.map((e) => [e.campaign, e]));
  assert.equal(byKey["ld-general"].spend, 60); // 40 × 1.50
  assert.equal(byKey["ld-general"].leadsReported, 40);
  assert.equal(byKey["ld-custom"].spend, 30); // 10 × 3
  assert.equal(byKey["ld-custom-2"].spend, 0); // zero row keeps re-runs self-correcting
  assert.equal(byKey["ld-custom-3"].spend, 0); // zero row keeps re-runs self-correcting
  assert.equal(byKey["ld-general"].domain, "WYNN");
  assert.equal(byKey["ld-general"].channel, "lead-data");
  assert.equal(byKey["ld-general"].raw.computedBy, "ld-spend-materializer");
});

test("findLdCollisions: manual nudges flagged; our own rows and non-LD rows ignored", () => {
  const collisions = findLdCollisions({
    dateKey: "2026-06-11",
    existingRows: [
      // our own materialized row — not a collision
      { date: "2026-06-11", source: "LD GENERAL", channel: "lead-data", campaign: "ld-general", spend: 60, raw: { computedBy: "ld-spend-materializer" } },
      // a manual nudge an operator entered — collision
      { date: "2026-06-11", source: "LD Custom correction", channel: "lead-data", campaign: null, spend: 45, raw: null },
      { date: "2026-06-11", source: "LD Custom 3 correction", channel: "lead-data", campaign: null, spend: 21, raw: null },
      // mail row — ignored
      { date: "2026-06-11", source: "Urgent Third Pink State", channel: "mailer", spend: 5000, raw: null },
      // different date — ignored
      { date: "2026-06-10", source: "ld general", channel: "lead-data", spend: 80, raw: null },
    ],
  });
  assert.equal(collisions.length, 2);
  const byFamily = Object.fromEntries(collisions.map((row) => [row.familyKey, row]));
  assert.equal(byFamily["ld-custom"].spend, 45);
  assert.equal(byFamily["ld-custom-3"].spend, 21);
});
