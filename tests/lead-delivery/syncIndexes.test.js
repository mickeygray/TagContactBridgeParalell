"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KNOWN_MODELS,
  indexDefinitionsMatch,
  parseArgs,
  planIndexChanges,
} = require("../../scripts/sync-indexes");

function declared(fields, options = {}) {
  return { fields, options };
}

function actual(key, options = {}) {
  return { key, name: "candidate_index", ...options };
}

test("lead-delivery models remain in the explicit sync allowlist", () => {
  assert.deepEqual(
    KNOWN_MODELS.filter((name) => name.startsWith("LeadDelivery")),
    ["LeadDeliveryAgent", "LeadDeliveryCheckpoint", "LeadDeliveryEvent", "LeadDeliveryItem"],
  );
});

test("requiring the module exposes argument parsing without running the CLI", () => {
  assert.deepEqual(parseArgs(["--dry-run", "LeadDeliveryItem"]), {
    dryRun: true,
    only: "LeadDeliveryItem",
  });
});

test("matching key patterns with different unique options require replacement", () => {
  const schemaIndexes = [declared(
    { providerExternalLeadId: 1 },
    { unique: true },
  )];
  const databaseIndexes = [actual({ providerExternalLeadId: 1 })];

  const plan = planIndexChanges(schemaIndexes, databaseIndexes);

  assert.deepEqual(plan.toAdd, schemaIndexes);
  assert.deepEqual(plan.toDrop, databaseIndexes);
});

test("matching key patterns with different sparse options require replacement", () => {
  const schemaIndexes = [declared({ providerContactId: 1 }, { sparse: true })];
  const databaseIndexes = [actual({ providerContactId: 1 })];

  const plan = planIndexChanges(schemaIndexes, databaseIndexes);

  assert.deepEqual(plan.toAdd, schemaIndexes);
  assert.deepEqual(plan.toDrop, databaseIndexes);
});

test("matching key patterns with different partial filters require replacement", () => {
  const schemaIndexes = [declared(
    { providerEventId: 1 },
    { partialFilterExpression: { providerEventId: { $type: "string" } } },
  )];
  const databaseIndexes = [actual(
    { providerEventId: 1 },
    { partialFilterExpression: { providerEventId: { $exists: true } } },
  )];

  const plan = planIndexChanges(schemaIndexes, databaseIndexes);

  assert.deepEqual(plan.toAdd, schemaIndexes);
  assert.deepEqual(plan.toDrop, databaseIndexes);
});

test("equivalent partial filters match despite object property order", () => {
  const schemaIndex = declared(
    { provider: 1, providerContactId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        provider: { $type: "string", $exists: true },
        providerContactId: { $type: "string" },
      },
    },
  );
  const databaseIndex = actual(
    { provider: 1, providerContactId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        providerContactId: { $type: "string" },
        provider: { $exists: true, $type: "string" },
      },
      background: true,
      v: 2,
    },
  );

  assert.equal(indexDefinitionsMatch(schemaIndex, databaseIndex), true);
  assert.deepEqual(planIndexChanges([schemaIndex], [databaseIndex]), {
    toAdd: [],
    toDrop: [],
  });
});

test("compound index field order remains significant", () => {
  const schemaIndex = declared({ state: 1, sourcePool: 1 });
  const databaseIndex = actual({ sourcePool: 1, state: 1 });

  assert.equal(indexDefinitionsMatch(schemaIndex, databaseIndex), false);
});

test("the Mongo _id index is never proposed for removal", () => {
  const idIndex = { key: { _id: 1 }, name: "_id_", v: 2 };

  assert.deepEqual(planIndexChanges([], [idIndex]), {
    toAdd: [],
    toDrop: [],
  });
});
