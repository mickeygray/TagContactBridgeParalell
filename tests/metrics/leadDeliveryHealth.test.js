"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LeadDeliveryItem } = require("../../packages/shared-models/src");

const {
  bandQuery,
  deriveLeadHealthAlerts,
  gatherLeadDeliveryHealth,
} = require("../../packages/shared-services/src/leadDeliveryHealthService");

function countModel(values) {
  const queries = [];
  return {
    queries,
    countDocuments(query) {
      queries.push(query);
      const value = values[queries.length - 1] ?? 0;
      return {
        maxTimeMS(limit) {
          assert.equal(limit, 5_000);
          return Promise.resolve(value);
        },
      };
    },
  };
}

test("contact bands preserve the Phase 9 zero, sub-ten, ten-to-fourteen, and phase-out boundaries", () => {
  assert.deepEqual(bandQuery("zeroTouch"), { totalAttemptCount: 0, lastContactAt: null });
  assert.deepEqual(bandQuery("highTouch"), { totalAttemptCount: { $gte: 10, $lt: 15 } });
  assert.deepEqual(bandQuery("phaseOut"), { totalAttemptCount: { $gte: 15 } });
  assert.throws(() => bandQuery("everything"), /band must be/);
});

test("the nightly band counts share an explicit covered lead-delivery index", () => {
  const declaration = LeadDeliveryItem.schema.indexes().find(([, options]) => (
    options?.name === "idx_lead_delivery_contact_band_health"
  ));
  assert.ok(declaration, "the count/rank index must be declared for live sync");
  assert.deepEqual(declaration[0], {
    state: 1,
    sourcePool: 1,
    totalAttemptCount: 1,
    nextContactAt: 1,
    lastContactAt: 1,
    receivedAt: -1,
    inventoryClass: 1,
  });
});

test("nightly lead health is count-only and identifies silent high-touch starvation", async () => {
  const items = countModel([
    8, 120, 40, 30,
    3, 17, 4, 1,
    2, 5, 6,
  ]);
  let attemptPipeline = null;
  const dailyDialModel = {
    aggregate(pipeline) {
      attemptPipeline = pipeline;
      return {
        option(options) {
          assert.deepEqual(options, { maxTimeMS: 5_000 });
          return Promise.resolve([{
            total: 90,
            firstTouches: 12,
            lowTouch: 35,
            highTouch: 30,
            phaseOut: 13,
          }]);
        },
      };
    },
  };

  const result = await gatherLeadDeliveryHealth({
    dateKey: "2026-08-13",
    at: new Date("2026-08-14T03:05:00.000Z"),
    itemModel: items,
    dailyDialModel,
    maxTimeMS: 5_000,
  });

  assert.equal(items.queries.length, 11);
  assert.deepEqual(result.inventory, {
    total: 198,
    zeroTouch: 8,
    lowTouch: 120,
    highTouch: 40,
    phaseOut: 30,
    due: { zeroTouch: 3, lowTouch: 17, highTouch: 4, phaseOut: 1 },
    zeroTouchOlderThanToday: 2,
    zeroTouchProviderHeld: 5,
    review: 6,
  });
  assert.deepEqual(result.attempts, {
    total: 90,
    firstTouches: 12,
    lowTouch: 35,
    highTouch: 30,
    phaseOut: 13,
  });
  assert.equal(result.alerts.zeroTouchDue, true);
  assert.equal(result.alerts.staleZeroTouch, true);
  assert.equal(result.alerts.highTouchWhileLightDue, true);
  assert.equal(result.alerts.attention, true);
  assert.deepEqual(attemptPipeline[0], { $match: { dateKey: "2026-08-13" } });
  assert.equal(JSON.stringify(result).includes("caseId"), false);
  assert.equal(JSON.stringify(result).includes("providerContactId"), false);
});

test("a quiet healthy day does not manufacture an alert", () => {
  const alerts = deriveLeadHealthAlerts({
    inventory: {
      zeroTouchOlderThanToday: 0,
      due: { zeroTouch: 0, lowTouch: 0 },
    },
    attempts: { total: 40, highTouch: 0, phaseOut: 0 },
  });
  assert.deepEqual(alerts, {
    staleZeroTouch: false,
    zeroTouchDue: false,
    lightWorkBacklog: false,
    highTouchWhileLightDue: false,
    noCallsWithOpenWork: false,
    attention: false,
  });
});
