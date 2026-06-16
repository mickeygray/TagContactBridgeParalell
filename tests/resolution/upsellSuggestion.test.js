"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  hasOpenUpsellOpportunity,
  isUpsellSuggestionCandidate,
} = require("../../packages/shared-repositories/src/clientProfileRepository");

const NOW = new Date("2026-06-16T12:00:00Z");
const DAY = 86_400_000;

const active = (extra = {}) => ({ lifecycle: { status: "active" }, opportunities: [], ...extra });

// ── hasOpenUpsellOpportunity ──────────────────────────────────────────────────
test("hasOpenUpsellOpportunity: an opportunity with no/active status counts as open", () => {
  assert.equal(hasOpenUpsellOpportunity({ opportunities: [{ play: "FTA" }] }), true);
  assert.equal(hasOpenUpsellOpportunity({ opportunities: [{ play: "FTA", status: "open" }] }), true);
});

test("hasOpenUpsellOpportunity: closed-out opportunities don't count", () => {
  assert.equal(hasOpenUpsellOpportunity({ opportunities: [{ status: "dismissed" }, { status: "done" }] }), false);
});

test("hasOpenUpsellOpportunity: mixed open + closed still counts as open", () => {
  assert.equal(hasOpenUpsellOpportunity({ opportunities: [{ status: "done" }, { play: "amended" }] }), true);
});

test("hasOpenUpsellOpportunity: no opportunities → false", () => {
  assert.equal(hasOpenUpsellOpportunity({ opportunities: [] }), false);
  assert.equal(hasOpenUpsellOpportunity({}), false);
});

// ── isUpsellSuggestionCandidate ───────────────────────────────────────────────
test("candidate: active + open opportunity + not snoozed → true", () => {
  assert.equal(isUpsellSuggestionCandidate(active({ opportunities: [{ play: "FTA" }] }), NOW), true);
});

test("candidate: retired profile → false", () => {
  const p = { lifecycle: { status: "retired" }, opportunities: [{ play: "FTA" }] };
  assert.equal(isUpsellSuggestionCandidate(p, NOW), false);
});

test("candidate: snoozed (checkAgainOn in the future) → false", () => {
  const p = active({ opportunities: [{ play: "FTA" }], upsell: { checkAgainOn: new Date(NOW.getTime() + DAY) } });
  assert.equal(isUpsellSuggestionCandidate(p, NOW), false);
});

test("candidate: expired snooze → eligible again", () => {
  const p = active({ opportunities: [{ play: "FTA" }], upsell: { checkAgainOn: new Date(NOW.getTime() - DAY) } });
  assert.equal(isUpsellSuggestionCandidate(p, NOW), true);
});

test("candidate: no open opportunity → false even when active + not snoozed", () => {
  assert.equal(isUpsellSuggestionCandidate(active({ opportunities: [{ status: "done" }] }), NOW), false);
  assert.equal(isUpsellSuggestionCandidate(active(), NOW), false);
});

test("candidate: null profile → false", () => {
  assert.equal(isUpsellSuggestionCandidate(null, NOW), false);
});
