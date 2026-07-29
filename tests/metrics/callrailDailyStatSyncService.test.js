"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createCallrailDailyStatSync,
} = require("../../packages/shared-services/src/callrailDailyStatSyncService");

function sampleCall(overrides = {}) {
  return {
    id: "call-1",
    customer_phone_number: "5550000001",
    tracking_phone_number: "5550000002",
    source_name: "Mailer One",
    start_time: "2026-07-20T09:00:00.000-07:00",
    duration: 360,
    direction: "inbound",
    first_call: true,
    ...overrides,
  };
}

function fakeClient(payload) {
  return () => ({ listInboundCallsForRange: async () => payload });
}

function memoryModel(initial = []) {
  const docs = initial.map((row) => ({ ...row }));
  const counters = { find: 0, bulkWrite: 0, updateMany: 0 };
  return {
    docs,
    counters,
    find() {
      counters.find += 1;
      return { lean: async () => docs.map((row) => ({ ...row })) };
    },
    async bulkWrite(operations) {
      counters.bulkWrite += 1;
      let modifiedCount = 0;
      let upsertedCount = 0;
      for (const operation of operations) {
        const { filter, update, upsert } = operation.updateOne;
        let row = filter._id
          ? docs.find((item) => String(item._id) === String(filter._id))
          : docs.find((item) => item.date === filter.date && item.piece === filter.piece);
        if (!row && upsert) {
          row = { _id: `upsert-${docs.length + 1}` };
          docs.push(row);
          upsertedCount += 1;
        } else if (row) {
          modifiedCount += 1;
        }
        if (row) Object.assign(row, update.$set);
      }
      return { modifiedCount, upsertedCount };
    },
    async updateMany(filter, update) {
      counters.updateMany += 1;
      const ids = new Set(filter._id.$in.map(String));
      let modifiedCount = 0;
      for (const row of docs) {
        if (ids.has(String(row._id)) && row.syncSource === "callrail-direct" && row.active !== false) {
          Object.assign(row, update.$set);
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
}

test("incomplete source images reject before any Mongo access", async () => {
  for (const payload of [
    { calls: [sampleCall()], total_records: 1, truncated: true },
    { calls: [sampleCall()], total_records: 2, truncated: false },
  ]) {
    const model = memoryModel();
    const sync = createCallrailDailyStatSync({
      DailyCallStatModel: model,
      createClient: fakeClient(payload),
    });
    await assert.rejects(
      sync({ from: "2026-07-20", to: "2026-07-20", dryRun: true }),
      (error) => /^CALLRAIL_(SOURCE_TRUNCATED|SOURCE_COUNT_MISMATCH)$/.test(error.code),
    );
    assert.deepEqual(model.counters, { find: 0, bulkWrite: 0, updateMany: 0 });
  }
});

test("dry run reports legacy claim and direct retirement without mutation", async () => {
  const model = memoryModel([
    { _id: "legacy", date: "2026-07-20", piece: "Mailer One", syncSource: null },
    { _id: "absent", date: "2026-07-20", piece: "Old Mailer", syncSource: "callrail-direct", active: true },
  ]);
  const sync = createCallrailDailyStatSync({
    DailyCallStatModel: model,
    createClient: fakeClient({ calls: [sampleCall()], total_records: 1 }),
  });
  const result = await sync({ from: "2026-07-20", to: "2026-07-20", dryRun: true });
  assert.equal(result.rowsWouldWrite, 1);
  assert.equal(result.legacyRowsWouldClaim, 1);
  assert.equal(result.rowsWouldRetire, 1);
  assert.equal(result.rowsWritten, 0);
  assert.equal(result.rowsRetired, 0);
  assert.equal(model.counters.bulkWrite, 0);
  assert.equal(model.counters.updateMany, 0);
  assert.equal(model.docs[1].active, true);
});

test("commit is non-destructive and an identical replay performs zero writes", async () => {
  const model = memoryModel([
    { _id: "legacy", date: "2026-07-20", piece: "Mailer One", syncSource: null },
    { _id: "absent", date: "2026-07-20", piece: "Old Mailer", syncSource: "callrail-direct", active: true },
  ]);
  const sync = createCallrailDailyStatSync({
    DailyCallStatModel: model,
    createClient: fakeClient({ calls: [sampleCall()], total_records: 1 }),
    now: () => new Date("2026-07-21T07:00:00.000Z"),
  });
  const first = await sync({ from: "2026-07-20", to: "2026-07-20" });
  assert.equal(first.rowsWritten, 1);
  assert.equal(first.rowsRetired, 1);
  assert.equal(model.docs.find((row) => row._id === "legacy").syncSource, "callrail-direct");
  assert.equal(model.docs.find((row) => row._id === "absent").active, false);
  const writeCount = model.counters.bulkWrite;
  const retireCount = model.counters.updateMany;

  const second = await sync({ from: "2026-07-20", to: "2026-07-20" });
  assert.equal(second.rowsWouldWrite, 0);
  assert.equal(second.rowsUnchanged, 1);
  assert.equal(second.rowsWouldRetire, 0);
  assert.equal(model.counters.bulkWrite, writeCount);
  assert.equal(model.counters.updateMany, retireCount);
});

test("duplicate provider identities reject before Mongo and legacy writers cannot claim direct rows", async () => {
  const model = memoryModel();
  const sync = createCallrailDailyStatSync({
    DailyCallStatModel: model,
    createClient: fakeClient({
      calls: [sampleCall(), sampleCall({ start_time: "2026-07-20T10:00:00.000-07:00" })],
      total_records: 2,
    }),
  });
  await assert.rejects(
    sync({ from: "2026-07-20", to: "2026-07-20" }),
    (error) => error.code === "CALLRAIL_DUPLICATE_IDENTITY",
  );
  assert.equal(model.counters.find, 0);

  const legacySource = fs.readFileSync(
    path.join(__dirname, "../../packages/shared-services/src/metricsBackfillService.js"),
    "utf8",
  );
  assert.equal((legacySource.match(/syncSource: \{ \$ne: "callrail-direct" \}/g) || []).length, 2);
});
test("invalid headline metric fields reject before Mongo access", async () => {
  for (const call of [
    sampleCall({ duration: "not-a-number" }),
    sampleCall({ first_call: undefined }),
  ]) {
    const model = memoryModel();
    const sync = createCallrailDailyStatSync({
      DailyCallStatModel: model,
      createClient: fakeClient({ calls: [call], total_records: 1 }),
    });
    await assert.rejects(
      sync({ from: "2026-07-20", to: "2026-07-20" }),
      (error) => /^CALLRAIL_INVALID_(DURATION|FIRST_CALL)$/.test(error.code),
    );
    assert.deepEqual(model.counters, { find: 0, bulkWrite: 0, updateMany: 0 });
  }
});