"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRecordLeadDeliveryCadenceCall,
} = require("../../apps/control-plane/src/services/leadDeliveryCadenceAction");

function fakeCadenceModel(initial) {
  const doc = structuredClone(initial);
  function matches(filter) {
    if (filter.domain !== doc.domain || filter.caseId !== doc.caseId) return false;
    const singularNe = filter["counterCadence.lastLeadDeliveryCountedAttemptKey"]?.$ne;
    if (singularNe && doc.counterCadence.lastLeadDeliveryCountedAttemptKey === singularNe) return false;
    const ledgerNe = filter["counterCadence.leadDeliveryCountedAttemptKeys"]?.$ne;
    if (ledgerNe && doc.counterCadence.leadDeliveryCountedAttemptKeys.includes(ledgerNe)) return false;
    if (Array.isArray(filter.$or)) {
      const current = doc.counterCadence.lastCxDialedAt;
      const allowed = filter.$or.some((clause) => {
        const condition = clause["counterCadence.lastCxDialedAt"];
        if (condition?.$exists === false) return current === undefined;
        if (condition === null) return current == null;
        if (condition?.$lte) return current != null
          && new Date(current).getTime() <= new Date(condition.$lte).getTime();
        return false;
      });
      if (!allowed) return false;
    }
    return true;
  }
  function setPath(path, value) {
    const parts = path.split(".");
    let target = doc;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
  }
  return {
    doc,
    findOne(filter) {
      const found = filter.domain === doc.domain && filter.caseId === doc.caseId ? doc : null;
      return {
        select() { return this; },
        async lean() { return found == null ? null : structuredClone(found); },
      };
    },
    async updateOne(filter, update) {
      if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
      for (const [path, value] of Object.entries(update.$set || {})) setPath(path, value);
      for (const [path, value] of Object.entries(update.$inc || {})) {
        const parts = path.split(".");
        let target = doc;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = Number(target[parts.at(-1)] || 0) + Number(value);
      }
      for (const [path, value] of Object.entries(update.$max || {})) {
        const parts = path.split(".");
        let target = doc;
        for (const part of parts.slice(0, -1)) target = target[part];
        const key = parts.at(-1);
        if (target[key] == null || Number(target[key]) < Number(value)) target[key] = value;
      }
      for (const [path, value] of Object.entries(update.$addToSet || {})) {
        const parts = path.split(".");
        let target = doc;
        for (const part of parts.slice(0, -1)) target = target[part];
        const key = parts.at(-1);
        if (!target[key].includes(value)) target[key].push(value);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async exists(filter) {
      return filter.domain === doc.domain && filter.caseId === doc.caseId;
    },
  };
}

test("a delayed exact attempt counts once without replacing the newer cadence snapshot", async () => {
  const model = fakeCadenceModel({
    domain: "WYNN",
    caseId: 42,
    cadenceCounters: { cx: 1 },
    lastTouched: { cx: new Date("2026-07-11T14:51:00.000Z") },
    counterCadence: {
      lastLeadDeliveryCountedCallId: "new-call",
      lastLeadDeliveryCountedAttemptKey: "new-attempt",
      leadDeliveryCountedAttemptKeys: ["new-attempt"],
      lastCxDialedAt: new Date("2026-07-11T14:51:00.000Z"),
      cxDailyDateKey: "2026-07-11",
      cxDailyCalls: 1,
    },
  });
  const record = createRecordLeadDeliveryCadenceCall({ LeadCadence: model });
  const historical = {
    domain: "WYNN",
    caseId: 42,
    providerCallId: "old-call",
    providerAttemptKey: "old-attempt",
    completedAt: new Date("2026-07-11T00:30:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
    totalAttemptCount: 2,
    historicalAttempt: true,
  };

  assert.deepEqual(await record(historical), { ok: true, counted: true });
  assert.equal(model.doc.cadenceCounters.cx, 2);
  assert.deepEqual(model.doc.counterCadence.leadDeliveryCountedAttemptKeys, [
    "new-attempt",
    "old-attempt",
  ]);
  assert.equal(model.doc.counterCadence.lastLeadDeliveryCountedAttemptKey, "new-attempt");
  assert.equal(model.doc.counterCadence.lastCxDialedAt.toISOString(), "2026-07-11T14:51:00.000Z");
  assert.equal(model.doc.counterCadence.cxDailyDateKey, "2026-07-11");
  assert.equal(model.doc.counterCadence.cxDailyCalls, 1);
  assert.equal(model.doc.totalAttemptCount, 2);
  assert.equal(model.doc.lastContactAt.toISOString(), "2026-07-11T14:51:00.000Z");

  assert.deepEqual(await record(historical), { ok: true, counted: false });
  assert.equal(model.doc.cadenceCounters.cx, 2);
});

test("legacy singular idempotency is backfilled before a newer attempt replaces it", async () => {
  const model = fakeCadenceModel({
    domain: "TAG",
    caseId: 9,
    cadenceCounters: { cx: 1 },
    lastTouched: { cx: new Date("2026-07-10T18:00:00.000Z") },
    counterCadence: {
      lastLeadDeliveryCountedCallId: "legacy-call",
      lastLeadDeliveryCountedAttemptKey: "legacy-attempt",
      leadDeliveryCountedAttemptKeys: [],
      lastCxDialedAt: new Date("2026-07-10T18:00:00.000Z"),
      cxDailyDateKey: "2026-07-10",
      cxDailyCalls: 1,
    },
  });
  const record = createRecordLeadDeliveryCadenceCall({ LeadCadence: model });
  const legacy = {
    domain: "TAG",
    caseId: 9,
    providerCallId: "legacy-call",
    providerAttemptKey: "legacy-attempt",
    completedAt: new Date("2026-07-10T18:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-10",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
  };
  assert.deepEqual(await record(legacy), { ok: true, counted: false });
  assert.deepEqual(model.doc.counterCadence.leadDeliveryCountedAttemptKeys, ["legacy-attempt"]);

  assert.deepEqual(await record({
    ...legacy,
    providerCallId: "new-call",
    providerAttemptKey: "new-attempt",
    completedAt: new Date("2026-07-11T18:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-11",
    totalAttemptCount: 2,
  }), { ok: true, counted: true });
  assert.equal(model.doc.cadenceCounters.cx, 2);
  assert.equal(model.doc.counterCadence.lastLeadDeliveryCountedAttemptKey, "new-attempt");

  assert.deepEqual(await record(legacy), { ok: true, counted: false });
  assert.equal(model.doc.cadenceCounters.cx, 2);
});

test("a current exact attempt advances both its idempotency ledger and latest snapshot", async () => {
  const model = fakeCadenceModel({
    domain: "TAG",
    caseId: 7,
    cadenceCounters: { cx: 0 },
    lastTouched: { cx: null },
    counterCadence: {
      lastLeadDeliveryCountedCallId: null,
      lastLeadDeliveryCountedAttemptKey: null,
      leadDeliveryCountedAttemptKeys: [],
      lastCxDialedAt: null,
      cxDailyDateKey: null,
      cxDailyCalls: 0,
    },
  });
  const record = createRecordLeadDeliveryCadenceCall({ LeadCadence: model });
  const result = await record({
    domain: "TAG",
    caseId: 7,
    providerCallId: "call-1",
    providerAttemptKey: "attempt-1",
    completedAt: new Date("2026-07-13T18:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-13",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
  });

  assert.deepEqual(result, { ok: true, counted: true });
  assert.equal(model.doc.cadenceCounters.cx, 1);
  assert.equal(model.doc.counterCadence.lastLeadDeliveryCountedAttemptKey, "attempt-1");
  assert.deepEqual(model.doc.counterCadence.leadDeliveryCountedAttemptKeys, ["attempt-1"]);
  assert.equal(model.doc.counterCadence.cxDailyDateKey, "2026-07-13");
  assert.equal(model.doc.counterCadence.cxDailyCalls, 1);
  assert.equal(model.doc.totalAttemptCount, 1);
  assert.equal(model.doc.lastContactAt.toISOString(), "2026-07-13T18:00:00.000Z");
});

test("a call without a LeadCadence source is an explicit non-error skip", async () => {
  const model = {
    findOne() {
      return {
        select() { return this; },
        async lean() { return null; },
      };
    },
    async updateOne() {
      throw new Error("missing cadence must be detected before writing");
    },
    async exists() { return false; },
  };
  const record = createRecordLeadDeliveryCadenceCall({ LeadCadence: model });

  const result = await record({
    domain: "TAG",
    caseId: 99,
    providerCallId: "call-old-yellow",
    providerAttemptKey: "attempt-old-yellow",
    completedAt: new Date("2026-07-16T18:00:00.000Z"),
    dailyAttemptDateKey: "2026-07-16",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
  });

  assert.deepEqual(result, {
    ok: true,
    counted: false,
    skipped: true,
    reason: "cadence-source-missing",
  });
});
