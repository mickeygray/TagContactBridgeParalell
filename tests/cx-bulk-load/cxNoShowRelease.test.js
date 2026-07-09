"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PILOT_FAMILY,
  buildNoShowDialedPilotRowsQuery,
  buildNoShowReleaseFilter,
  buildNoShowReleasePatch,
  buildNoShowSessionQuery,
  cancelNoShowPublishedRows,
  compareNoShowSortTuples,
  parseNoShowSince,
  shouldReleaseNoShow,
  shouldWriteNoShowRelease,
} = require("../../scripts/cx-pilot-queue");

test("no-show session query is scoped to running/killed sessions since local cutoff", () => {
  const sinceAt = new Date("2026-07-08T13:00:00.000Z");
  assert.deepEqual(buildNoShowSessionQuery("Sean@Test.com", sinceAt), {
    agentEmail: "sean@test.com",
    status: { $in: ["running", "killed"] },
    createdAt: { $gte: sinceAt },
  });
});

test("no-show dialed query only treats today's dialed pilot rows as activity", () => {
  const sinceAt = new Date("2026-07-08T13:00:00.000Z");
  const query = buildNoShowDialedPilotRowsQuery("Sean@Test.com", "wynn", "2026-07-08", sinceAt);

  assert.equal(query.domain, "WYNN");
  assert.equal(query.queueFamily, PILOT_FAMILY);
  assert.equal(query["metadata.pilotAgentEmail"], "sean@test.com");
  assert.deepEqual(query.placedCalls, { $gt: 0 });
  assert.ok(query.$or.some((branch) => branch.dailyPlacedDateKey === "2026-07-08"));
  assert.ok(query.$or.some((branch) => branch.lastPlacedAt?.$gte === sinceAt));
});

test("release filter never selects dialed rows or non-pilot families", () => {
  const filter = buildNoShowReleaseFilter("Sean@Test.com", "wynn");

  assert.equal(filter.domain, "WYNN");
  assert.equal(filter.queueFamily, PILOT_FAMILY);
  assert.deepEqual(filter.state, { $in: ["ready", "claimed"] });
  assert.equal(filter.placedCalls, 0);
  assert.equal(filter["metadata.pilotAgentEmail"], "sean@test.com");
});

test("release patch restamps receiver route, clears old ownership, and adds no weight", () => {
  const now = new Date("2026-07-08T15:00:00.000Z");
  const patch = buildNoShowReleasePatch({
    fromAgent: "Sean@Test.com",
    toAgent: "Active@Test.com",
    route: { accountId: "50810001", campaignId: "2344", dialGroupId: "1011" },
    now,
  });

  assert.equal(patch.$set.state, "ready");
  assert.equal(Object.hasOwn(patch.$set, "queueFamilyRank"), false);
  assert.equal(patch.$set.priorityScore, 100);
  assert.equal(patch.$set.releaseAt, now);
  assert.equal(patch.$set.rcxAccountId, "50810001");
  assert.equal(patch.$set.rcxCampaignId, "2344");
  assert.equal(patch.$set.rcxDialGroupId, "1011");
  assert.equal(patch.$set["metadata.pilotAgentEmail"], "active@test.com");
  assert.deepEqual(patch.$set["metadata.noShowRelease"], {
    fromAgent: "sean@test.com",
    toAgent: "active@test.com",
    at: now.toISOString(),
    releasedBy: "noshow-release",
  });
  assert.equal(patch.$set["assignment.extensionId"], null);
  assert.ok(Object.hasOwn(patch.$unset, "metadata.reservationSessionId"));
  assert.ok(Object.hasOwn(patch.$unset, "metadata.lastRingcxPublishedExternId"));
  assert.ok(Object.hasOwn(patch.$unset, "metadata.rcxVisibilityExternId"));
});

test("released rows no longer get artificial priority over fresh rank-zero pilot rows", () => {
  const now = new Date("2026-07-08T15:00:00.000Z");
  const released = {
    queueFamilyRank: 0,
    dailyPlacedCalls: 0,
    progressiveStageIndex: 99,
    lastPlacedAt: null,
    priorityScore: 100,
    releaseAt: now,
    createdAt: new Date("2026-07-08T14:59:00.000Z"),
  };
  const freshRankZero = {
    ...released,
    priorityScore: 100,
    releaseAt: new Date("2026-07-08T14:59:00.000Z"),
    createdAt: new Date("2026-07-08T15:01:00.000Z"),
  };
  const freshRankOne = {
    ...freshRankZero,
    queueFamilyRank: 1,
  };

  assert.equal(compareNoShowSortTuples(released, freshRankZero), 1);
  assert.equal(compareNoShowSortTuples(released, freshRankOne), -1);
});

test("RingCX cleanout is dry-run safe and armed failures are visible", async () => {
  const rows = [
    { _id: "q1", caseId: 101, metadata: { rcxVisibilityExternId: "extern-1" } },
    { _id: "q2", caseId: 102, metadata: {} },
  ];
  const dry = await cancelNoShowPublishedRows(rows, {
    arm: false,
    cancelFn: async () => {
      throw new Error("should not run");
    },
  });
  assert.deepEqual(dry, { checked: 2, published: 1, cancelled: 0, skipped: 1, failed: 0 });

  const armed = await cancelNoShowPublishedRows(rows, {
    arm: true,
    cancelFn: async () => ({ ok: false, cancelled: false, campaignId: "camp", externId: "extern-1", error: "boom" }),
  });
  assert.deepEqual(armed, { checked: 2, published: 1, cancelled: 0, skipped: 0, failed: 1 });
});

test("dry-run is pinned to no-write even when rows are releasable", () => {
  assert.equal(shouldReleaseNoShow({ sessionCount: 0, dialedCount: 0 }), true);
  assert.equal(shouldReleaseNoShow({ sessionCount: 1, dialedCount: 0 }), false);
  assert.equal(shouldReleaseNoShow({ sessionCount: 0, dialedCount: 1 }), false);

  assert.equal(shouldWriteNoShowRelease({ arm: false, noShow: true, releaseCount: 10 }), false);
  assert.equal(shouldWriteNoShowRelease({ arm: true, noShow: false, releaseCount: 10 }), false);
  assert.equal(shouldWriteNoShowRelease({ arm: true, noShow: true, releaseCount: 0 }), false);
  assert.equal(shouldWriteNoShowRelease({ arm: true, noShow: true, releaseCount: 10 }), true);
});

test("default no-show cutoff resolves the current Pacific day at 06:00", () => {
  const now = new Date("2026-07-08T19:30:00.000Z");
  assert.equal(parseNoShowSince("06:00", now).toISOString(), "2026-07-08T13:00:00.000Z");
});
