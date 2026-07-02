"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCadenceQuery,
  buildGreenFirstTouchQueueRow,
  createCxGreenFirstTouchQueueMaterializer,
  hasConfirmedCxTouch,
  normalizeRouteCampaigns,
  pickLeadPhone,
} = require("../../packages/shared-services/src/cxGreenFirstTouchQueueMaterializerService");

function makeLeadCadenceModel(rows) {
  const state = {
    lastQuery: null,
    sortValue: null,
    limitValue: null,
  };
  return {
    state,
    find(query) {
      state.lastQuery = query;
      const chain = {
        sort(value) {
          state.sortValue = value;
          return chain;
        },
        limit(value) {
          state.limitValue = value;
          return chain;
        },
        async lean() {
          return rows;
        },
      };
      return chain;
    },
  };
}

function makeQueueRepository(existingActionKeys = []) {
  return {
    existingActionKeys: new Set(existingActionKeys),
    listCalls: [],
    writes: [],
    async listQueueItems(input) {
      this.listCalls.push(input);
      return this.existingActionKeys.has(input.metadataActionKey)
        ? [{ _id: input.metadataActionKey }]
        : [];
    },
    async upsertQueueItem(domain, caseId, row, options) {
      this.writes.push({ domain, caseId, row, options });
      return { _id: options.actionKey, ...row };
    },
  };
}

test("normalizes route campaigns and phones for first-touch inputs", () => {
  assert.deepEqual(normalizeRouteCampaigns("WYNN:Green, wynn:green, TAG:Blue"), [
    "wynn:green",
    "tag:blue",
  ]);
  assert.equal(pickLeadPhone({ primaryPhone: "(714) 555-1122" }), "7145551122");
  assert.equal(pickLeadPhone({ normalizedPhone: "17145553333" }), "7145553333");
});

test("touch proof blocks any cadence row with prior cx proof", () => {
  assert.equal(hasConfirmedCxTouch({ counterCadence: { cxDailyCalls: 0, cxMonthlyCalls: 1 } }), true);
  assert.equal(hasConfirmedCxTouch({ cadenceCounters: { cx: 1 } }), true);
  assert.equal(hasConfirmedCxTouch({ lastTouched: { cx: "2026-06-29T14:00:00.000Z" } }), true);
  assert.equal(hasConfirmedCxTouch({ counterCadence: { cxDailyCalls: 0, cxMonthlyCalls: 0 } }), false);
});

test("cadence query scopes the finite morning window and route campaigns", () => {
  const windowStartAt = new Date("2026-06-26T07:45:00.000Z");
  const cutoffAt = new Date("2026-06-29T07:45:00.000Z");
  const query = buildCadenceQuery({
    domain: "wynn",
    windowStartAt,
    cutoffAt,
    routeCampaigns: ["WYNN:Fresh", "wynn:fresh", "WYNN:Blue"],
  });

  assert.equal(query.domain, "WYNN");
  assert.equal(query.active, true);
  assert.deepEqual(query.createdAt, { $gte: windowStartAt, $lt: cutoffAt });
  assert.deepEqual(query.routeCampaignKey, { $in: ["wynn:fresh", "wynn:blue"] });
  assert.deepEqual(query.$or, [
    { normalizedPhone: { $nin: [null, ""] } },
    { primaryPhone: { $nin: [null, ""] } },
  ]);
});

test("dry run reports eligible first-touch rows without writing queue rows", async () => {
  const rows = [
    {
      _id: "cadence-1",
      domain: "WYNN",
      caseId: 101,
      firstName: "Fresh",
      lastName: "Green",
      normalizedPhone: "7145550001",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
      cadenceCounters: { cx: 0 },
    },
    {
      _id: "cadence-2",
      domain: "WYNN",
      caseId: 102,
      firstName: "Already",
      lastName: "Touched",
      normalizedPhone: "7145550002",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:10:00.000Z"),
      counterCadence: { cxMonthlyCalls: 1 },
    },
    {
      _id: "cadence-3",
      domain: "WYNN",
      caseId: 103,
      firstName: "Blocked",
      lastName: "Lead",
      normalizedPhone: "7145550003",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:20:00.000Z"),
      cadenceState: { channelDnc: { cx: { blocked: true } } },
    },
    {
      _id: "cadence-4",
      domain: "WYNN",
      caseId: 104,
      firstName: "No",
      lastName: "Phone",
      routeCampaignKey: "wynn:fresh",
      createdAt: new Date("2026-06-28T18:30:00.000Z"),
    },
  ];
  const leadCadenceModel = makeLeadCadenceModel(rows);
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel,
    queueRepository,
    logger: {},
    now: () => new Date("2026-06-29T15:00:00.000Z"),
  });

  const result = await materializer.materialize({
    domain: "wynn",
    routeCampaigns: ["wynn:fresh"],
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    asOf: new Date("2026-06-29T15:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.batchId, "green-coverage-2026-06-29-WYNN");
  assert.equal(result.scanned, 4);
  assert.equal(result.eligible, 1);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped["already-touched"], 1);
  assert.equal(result.skipped["cx-dnc"], 1);
  assert.equal(result.skipped["missing-phone"], 1);
  assert.equal(queueRepository.writes.length, 0);
  assert.equal(queueRepository.listCalls.length, 1);
  assert.deepEqual(leadCadenceModel.state.lastQuery.routeCampaignKey, { $in: ["wynn:fresh"] });
});

test("apply writes a scoped first-touch queue row with RingCX route and idempotency key", async () => {
  const rows = [{
    _id: "cadence-201",
    domain: "TAG",
    caseId: 201,
    name: "Case Ready",
    primaryPhone: "714-555-0201",
    routeCampaignKey: "tag:fresh",
    routeCampaignName: "TAG Fresh",
    createdAt: new Date("2026-06-28T16:00:00.000Z"),
  }];
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel(rows),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "tag",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
    routeCampaigns: ["tag:fresh"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.created, 1);
  assert.equal(queueRepository.writes.length, 1);

  const write = queueRepository.writes[0];
  assert.equal(write.domain, "TAG");
  assert.equal(write.caseId, 201);
  assert.equal(write.options.actionKey, "cx-green-first-touch:green-coverage-2026-06-29-TAG:TAG:201");
  assert.equal(write.row.state, "ready");
  assert.equal(write.row.queueFamily, "fresh-day1");
  assert.equal(write.row.phone, "7145550201");
  assert.equal(write.row.rcxAccountId, "acct1");
  assert.equal(write.row.rcxCampaignId, "camp1");
  assert.equal(write.row.rcxDialGroupId, "dg1");
  assert.equal(write.row["metadata.firstTouchOnly"], true);
  assert.equal(write.row["metadata.greenCoverageBatchId"], "green-coverage-2026-06-29-TAG");
  assert.equal(write.row["metadata.queueLane"], "morningCoverage");
  assert.equal(write.row["metadata.actionKey"], write.options.actionKey);
  assert.equal(write.row["metadata.cxTouchProofAtMaterialize"].totalCalls, 0);
});

test("existing active queue row dedupes by action key", async () => {
  const actionKey = "cx-green-first-touch:green-coverage-2026-06-29-WYNN:WYNN:301";
  const queueRepository = makeQueueRepository([actionKey]);
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-301",
      domain: "WYNN",
      caseId: 301,
      primaryPhone: "7145550301",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyQueued, 1);
  assert.equal(result.created, 0);
  assert.equal(queueRepository.writes.length, 0);
});

test("existing terminal queue row blocks first-touch resurrection", async () => {
  const queueRepository = {
    writes: [],
    async listQueueItems() {
      return [{ _id: "terminal-row", state: "completed" }];
    },
    async upsertQueueItem(domain, caseId, row, options) {
      this.writes.push({ domain, caseId, row, options });
      return { _id: options.actionKey, ...row };
    },
  };
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-302",
      domain: "WYNN",
      caseId: 302,
      primaryPhone: "7145550302",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.terminalQueued, 1);
  assert.equal(result.skipped["terminal-queue-row"], 1);
  assert.equal(result.created, 0);
  assert.equal(queueRepository.writes.length, 0);
});

test("materializer reports truncation when create limit is reached", async () => {
  const rows = [1, 2, 3].map((n) => ({
    _id: `cadence-60${n}`,
    domain: "WYNN",
    caseId: 600 + n,
    primaryPhone: `714555060${n}`,
    createdAt: new Date("2026-06-28T18:00:00.000Z"),
  }));
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel(rows),
    queueRepository: makeQueueRepository(),
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    limit: 1,
    scanLimit: 10,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.scanLimitReached, false);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.remainingCandidateCount, 2);
});

test("missing RingCX route fails closed before creating queue rows", async () => {
  const queueRepository = makeQueueRepository();
  const materializer = createCxGreenFirstTouchQueueMaterializer({
    leadCadenceModel: makeLeadCadenceModel([{
      _id: "cadence-401",
      domain: "WYNN",
      caseId: 401,
      primaryPhone: "7145550401",
      createdAt: new Date("2026-06-28T18:00:00.000Z"),
    }]),
    queueRepository,
    logger: {},
  });

  const result = await materializer.materialize({
    domain: "wynn",
    apply: true,
    asOf: new Date("2026-06-29T15:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-ringcx-route");
  assert.equal(result.created, 0);
  assert.equal(result.skipped["missing-ringcx-route"], 1);
  assert.equal(queueRepository.writes.length, 0);
});

test("queue row builder keeps the shape consumed by first-touch reservation", () => {
  const row = buildGreenFirstTouchQueueRow({
    _id: "cadence-501",
    domain: "WYNN",
    caseId: 501,
    firstName: "Shape",
    lastName: "Check",
    primaryPhone: "7145550501",
    routeCampaignKey: "wynn:fresh",
  }, {
    domain: "wynn",
    batchId: "green-coverage-2026-06-29-WYNN",
    now: new Date("2026-06-29T15:00:00.000Z"),
    ringcx: { accountId: "acct1", campaignId: "camp1", dialGroupId: "dg1" },
  });

  assert.equal(row.domain, "WYNN");
  assert.equal(row.caseId, 501);
  assert.equal(row.name, "Shape Check");
  assert.equal(row.phone, "7145550501");
  assert.equal(row.queueFamily, "fresh-day1");
  assert.equal(row.placedCalls, 0);
  assert.equal(row.dailyPlacedCalls, 0);
  assert.equal(row["metadata.firstTouchOnly"], true);
  assert.equal(row["metadata.greenCoverageScope"], "shared");
});
