"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReadyClaimQuery,
  buildReadyReservationQuery,
} = require("../../packages/shared-repositories/src/cxDialQueueRepository");

function hasOrClause(query, field, predicate) {
  const clauses = Array.isArray(query.$and) ? query.$and : [];
  return clauses.some((clause) => {
    const parts = Array.isArray(clause.$or) ? clause.$or : [];
    return parts.some((part) => predicate(part[field]));
  });
}

test("firstTouchOnly adds zero-dial proof filters and finite batch scope", () => {
  const query = buildReadyClaimQuery("wynn", {
    queueFamily: "fresh-day1",
    routeCampaigns: ["wynn:camp1"],
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-WYNN",
  });

  assert.equal(query.state, "ready");
  assert.equal(query.domain, "WYNN");
  assert.deepEqual(query.queueFamily, { $in: ["fresh-day1"] });
  assert.deepEqual(query["metadata.routeCampaignKey"], { $in: ["wynn:camp1"] });
  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "dailyPlacedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "progressiveStageIndex", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.ok(query.$and.some((clause) => clause["metadata.greenCoverageBatchId"] === "green-coverage-2026-06-29-WYNN"));
});

test("normal ready claim query does not add first-touch filters", () => {
  const query = buildReadyClaimQuery("tag", { queueFamily: "fresh-day1" });
  assert.equal(query.domain, "TAG");
  assert.deepEqual(query.queueFamily, { $in: ["fresh-day1"] });
  assert.equal(query.$and, undefined);
});

test("first-touch reservation query keeps route and batch scope together", () => {
  const now = new Date("2026-06-29T15:00:00.000Z");
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    rcxAccountId: "acct1",
    rcxCampaignId: "camp1",
    rcxDialGroupId: "dg1",
  }, now);

  assert.equal(query.state, "ready");
  assert.equal(query.domain, "TAG");
  assert.equal(query.queueFamily, "fresh-day1");
  assert.deepEqual(query.releaseAt, { $lte: now });
  assert.deepEqual(query["metadata.appointmentId"], { $in: [null, ""] });
  assert.equal(query.rcxAccountId, "acct1");
  assert.equal(query.rcxCampaignId, "camp1");
  assert.equal(query.rcxDialGroupId, "dg1");
  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.ok(query.$and.some((clause) => clause["metadata.greenCoverageBatchId"] === "green-coverage-2026-06-29-TAG"));
});

test("firstTouchOnly honors an explicit max-attempt bound", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 2,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 2));
});

test("firstTouchOnly treats null max attempts as the default one-attempt bound", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: null,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(hasOrClause(query, "metadata.firstTouchAttempts", (value) => value && value.$lt === 1));
  assert.equal(query.$and.some((clause) => clause._id && clause._id.$exists === false), false);
});

test("firstTouchOnly with zero max attempts fails closed", () => {
  const query = buildReadyReservationQuery("tag", "fresh-day1", {
    firstTouchOnly: true,
    greenCoverageBatchId: "green-coverage-2026-06-29-TAG",
    firstTouchMaxAttempts: 0,
  }, new Date("2026-06-29T15:00:00.000Z"));

  assert.ok(query.$and.some((clause) => clause._id && clause._id.$exists === false));
});

test("firstTouchOnly fails closed without finite batch or lane scope", () => {
  const query = buildReadyClaimQuery("wynn", {
    queueFamily: "fresh-day1",
    firstTouchOnly: true,
  });

  assert.ok(hasOrClause(query, "placedCalls", (value) => value && value.$lte === 0));
  assert.ok(query.$and.some((clause) => clause._id && clause._id.$exists === false));
});
