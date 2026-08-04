"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  recordDailyDialOffload,
} = require("../../packages/shared-services/src/dailyDialLedgerService");
const {
  createPersistDailyDialsToCadence,
} = require("../../apps/control-plane/src/services/leadDeliveryDailyDialAction");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeDailyDialModel() {
  let doc = null;
  function matchesIdentity(filter) {
    return doc && doc.domain === filter.domain && doc.caseId === filter.caseId && doc.dateKey === filter.dateKey;
  }
  function setAttemptPath(path, value) {
    const match = path.match(/^attempts\.\$\.(.+)$/);
    if (!match) return;
    const attemptKey = currentAttemptKey;
    const attempt = doc.attempts.find((entry) => entry.attemptKey === attemptKey);
    if (attempt) attempt[match[1]] = clone(value);
  }
  let currentAttemptKey = null;
  return {
    get doc() { return doc; },
    async findOneAndUpdate(filter, update) {
      if (!doc) {
        doc = {
          _id: "daily-1",
          contactedToday: 0,
          capped: false,
          countedAttemptKeys: [],
          attempts: [],
          cadencePersistedAt: null,
          ...clone(update.$setOnInsert || {}),
        };
      }
      Object.assign(doc, clone(update.$set || {}));
      return clone(doc);
    },
    findOne(filter) {
      const found = matchesIdentity(filter) ? clone(doc) : null;
      return { async lean() { return found; } };
    },
    async updateOne(filter, update) {
      if (!matchesIdentity(filter) && filter._id !== doc?._id) return { matchedCount: 0 };
      if (matchesIdentity(filter)) {
        if (filter.terminal?.$ne === true && doc.terminal === true) return { matchedCount: 0 };
        if (filter.capped?.$ne === true && doc.capped === true) return { matchedCount: 0 };
        if (Array.isArray(filter.$or)) {
          const currentEnd = doc.callEndedAt ? new Date(doc.callEndedAt) : null;
          const matchesLatest = filter.$or.some((condition) => {
            if (condition.callEndedAt === null) return doc.callEndedAt == null;
            if (condition.callEndedAt?.$exists === false) return doc.callEndedAt === undefined;
            if (condition.callEndedAt?.$lte) {
              return !currentEnd || currentEnd.getTime() <= new Date(condition.callEndedAt.$lte).getTime();
            }
            return false;
          });
          if (!matchesLatest) return { matchedCount: 0 };
        }
      }
      if (filter["attempts.attemptKey"]) {
        currentAttemptKey = filter["attempts.attemptKey"];
        if (!doc.attempts.some((entry) => entry.attemptKey === currentAttemptKey)) {
          return { matchedCount: 0 };
        }
      }
      const unseen = filter.countedAttemptKeys?.$ne;
      if (unseen && doc.countedAttemptKeys.includes(unseen)) return { matchedCount: 0 };
      for (const [path, value] of Object.entries(update.$set || {})) {
        if (path.startsWith("attempts.$.")) setAttemptPath(path, value);
        else doc[path] = clone(value);
      }
      for (const [path, value] of Object.entries(update.$max || {})) {
        doc[path] = Math.max(Number(doc[path] || 0), Number(value));
      }
      if (update.$addToSet?.countedAttemptKeys
        && !doc.countedAttemptKeys.includes(update.$addToSet.countedAttemptKeys)) {
        doc.countedAttemptKeys.push(update.$addToSet.countedAttemptKeys);
      }
      if (update.$push?.attempts) doc.attempts.push(clone(update.$push.attempts));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

test("DailyDial records one exact attempt and later strengthens its outcome without recounting", async () => {
  const model = fakeDailyDialModel();
  const base = {
    model,
    cadence: {
      domain: "TAG",
      caseId: 42,
      receivedAt: new Date("2026-07-14T15:00:00.000Z"),
      normalizedPhone: "5555550100",
      firstName: "Test",
      lastName: "Lead",
    },
    originPool: "new_today",
    providerAttemptKey: "attempt-1",
    providerCallId: "call-1",
    provider: "phoneburner",
    agentId: "chris_bolt",
    connected: false,
    dailyAttemptDateKey: "2026-07-14",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callStartedAt: new Date("2026-07-14T18:00:00.000Z"),
    callEndedAt: new Date("2026-07-14T18:01:00.000Z"),
    durationSeconds: 60,
    recordingUrl: "https://recordings.example.invalid/call/1.mp3?token=test",
    nextContactAt: new Date("2026-07-14T19:31:00.000Z"),
  };
  const first = await recordDailyDialOffload({ ...base, normalizedOutcome: "review" });
  assert.equal(first.counted, true);
  assert.equal(model.doc.contactedToday, 1);
  assert.equal(model.doc.attempts.length, 1);
  assert.equal(model.doc.attempts[0].provider, "phoneburner");
  assert.equal(model.doc.attempts[0].connected, false);
  assert.equal(model.doc.attempts[0].outcome, "review");
  assert.equal(model.doc.attempts[0].recordingUrl, "https://recordings.example.invalid/call/1.mp3?token=test");
  assert.equal(model.doc.capped, false);
  assert.equal(model.doc.leadReceivedAt.toISOString(), "2026-07-14T15:00:00.000Z");
  assert.equal(model.doc.lastOffloadAt.toISOString(), "2026-07-14T18:01:00.000Z");

  const strengthened = await recordDailyDialOffload({
    ...base,
    normalizedOutcome: "dnc",
    nextContactAt: null,
  });
  assert.equal(strengthened.counted, false);
  assert.equal(model.doc.contactedToday, 1);
  assert.equal(model.doc.attempts.length, 1);
  assert.equal(model.doc.attempts[0].outcome, "dnc");
  assert.equal(model.doc.terminal, true);
  assert.equal(model.doc.capped, true);
  assert.equal(model.doc.nextEligibleAt, null);

  const weakReplay = await recordDailyDialOffload({
    ...base,
    normalizedOutcome: "review",
    connected: null,
  });
  assert.equal(weakReplay.counted, false);
  assert.equal(model.doc.attempts[0].outcome, "dnc");
  assert.equal(model.doc.attempts[0].connected, false);
  assert.equal(model.doc.attempts[0].recordingUrl, "https://recordings.example.invalid/call/1.mp3?token=test");
  assert.equal(model.doc.terminal, true);
  assert.equal(model.doc.nextEligibleAt, null);
});

test("late recording evidence strengthens one exact attempt without recounting", async () => {
  const model = fakeDailyDialModel();
  const input = {
    model,
    cadence: {
      domain: "TAG",
      caseId: 44,
      receivedAt: new Date("2026-07-14T15:00:00.000Z"),
    },
    originPool: "new_today",
    providerAttemptKey: "attempt-late",
    providerCallId: "call-late",
    provider: "phoneburner",
    agentId: "chris_bolt",
    normalizedOutcome: "voicemail",
    connected: false,
    dailyAttemptDateKey: "2026-07-14",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-07-14T18:01:00.000Z"),
  };
  const first = await recordDailyDialOffload(input);
  assert.equal(first.counted, true);
  assert.equal(model.doc.attempts[0].recordingUrl, null);

  const late = await recordDailyDialOffload({
    ...input,
    recordingUrl: "https://recordings.example.invalid/call/late.mp3?token=test",
  });
  assert.equal(late.counted, false);
  assert.equal(model.doc.contactedToday, 1);
  assert.equal(model.doc.attempts.length, 1);
  assert.equal(model.doc.attempts[0].recordingUrl, "https://recordings.example.invalid/call/late.mp3?token=test");

  const replay = await recordDailyDialOffload({
    ...input,
    recordingUrl: "https://recordings.example.invalid/call/late.mp3?token=test",
  });
  assert.equal(replay.counted, false);
  assert.equal(model.doc.attempts.length, 1);
  await assert.rejects(
    recordDailyDialOffload({
      ...input,
      recordingUrl: "https://recordings.example.invalid/call/conflict.mp3",
    }),
    /recording conflict/,
  );
});

test("delayed older callbacks append an attempt without regressing the latest daily snapshot", async () => {
  const model = fakeDailyDialModel();
  const common = {
    model,
    cadence: {
      domain: "TAG",
      caseId: 42,
      receivedAt: new Date("2026-07-14T15:00:00.000Z"),
    },
    originPool: "new_today",
    provider: "phoneburner",
    agentId: "chris_bolt",
    dailyAttemptDateKey: "2026-07-14",
    connected: false,
  };
  await recordDailyDialOffload({
    ...common,
    providerAttemptKey: "attempt-2",
    providerCallId: "call-2",
    normalizedOutcome: "voicemail",
    dailyAttemptCount: 2,
    totalAttemptCount: 2,
    callEndedAt: new Date("2026-07-14T20:01:00.000Z"),
    nextContactAt: new Date("2026-07-14T22:01:00.000Z"),
  });
  const delayed = await recordDailyDialOffload({
    ...common,
    providerAttemptKey: "attempt-1",
    providerCallId: "call-1",
    normalizedOutcome: "no_answer",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-07-14T18:01:00.000Z"),
    nextContactAt: new Date("2026-07-14T20:01:00.000Z"),
  });

  assert.equal(delayed.counted, true);
  assert.equal(model.doc.attempts.length, 2);
  assert.equal(model.doc.contactedToday, 2);
  assert.equal(model.doc.callEndedAt.toISOString(), "2026-07-14T20:01:00.000Z");
  assert.equal(model.doc.lastOffloadAt.toISOString(), "2026-07-14T20:01:00.000Z");
  assert.equal(model.doc.lastOutcome, "voicemail");
  assert.equal(model.doc.nextEligibleAt.toISOString(), "2026-07-14T22:01:00.000Z");
});

test("terminal and capped daily state cannot be reopened by a later nonterminal callback", async () => {
  const model = fakeDailyDialModel();
  const common = {
    model,
    cadence: {
      domain: "TAG",
      caseId: 42,
      receivedAt: new Date("2026-07-14T15:00:00.000Z"),
    },
    originPool: "new_today",
    provider: "phoneburner",
    agentId: "chris_bolt",
    dailyAttemptDateKey: "2026-07-14",
    connected: false,
  };
  await recordDailyDialOffload({
    ...common,
    providerAttemptKey: "attempt-1",
    providerCallId: "call-1",
    normalizedOutcome: "dnc",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-07-14T18:01:00.000Z"),
  });
  await recordDailyDialOffload({
    ...common,
    providerAttemptKey: "attempt-2",
    providerCallId: "call-2",
    normalizedOutcome: "voicemail",
    dailyAttemptCount: 2,
    totalAttemptCount: 2,
    callEndedAt: new Date("2026-07-14T20:01:00.000Z"),
    nextContactAt: new Date("2026-07-14T22:01:00.000Z"),
  });

  assert.equal(model.doc.attempts.length, 2);
  assert.equal(model.doc.terminal, true);
  assert.equal(model.doc.capped, true);
  assert.equal(model.doc.lastOutcome, "dnc");
  assert.equal(model.doc.nextEligibleAt, null);
});

test("day close replays DailyDial attempts through the exact-once cadence writer", async () => {
  const rows = [{
    _id: "daily-1",
    domain: "tag",
    caseId: "42",
    dateKey: "2026-07-14",
    cadencePersistedAt: null,
    attempts: [{
      attemptKey: "attempt-1",
      providerCallId: "call-1",
      callEndedAt: new Date("2026-07-14T18:01:00.000Z"),
      dailyAttemptCount: 1,
      totalAttemptCount: 3,
    }],
  }];
  const applied = [];
  const DailyDial = {
    find() {
      return {
        sort() { return this; },
        async lean() { return clone(rows); },
      };
    },
    async updateOne(filter, update) {
      assert.equal(filter._id, "daily-1");
      rows[0].cadencePersistedAt = update.$set.cadencePersistedAt;
      return { matchedCount: 1 };
    },
  };
  const persist = createPersistDailyDialsToCadence({
    DailyDial,
    recordCadence: async (action) => { applied.push(action); },
  });
  const result = await persist({ dateKey: "2026-07-14" });
  assert.deepEqual(result, {
    status: "completed",
    rows: 1,
    persisted: 1,
    attempts: 1,
    skipped: 0,
    skippedRows: 0,
  });
  assert.equal(applied[0].providerAttemptKey, "attempt-1");
  assert.equal(applied[0].dailyAttemptCount, 1);
  assert.equal(applied[0].totalAttemptCount, 3);
  assert.ok(rows[0].cadencePersistedAt instanceof Date);
});

test("day close marks a non-cadence DailyDial row reconciled and reports the skip", async () => {
  const rows = [{
    _id: "daily-yellow-1",
    domain: "tag",
    caseId: "99",
    dateKey: "2026-07-16",
    cadencePersistedAt: null,
    attempts: [{
      attemptKey: "attempt-yellow-1",
      providerCallId: "call-yellow-1",
      callEndedAt: new Date("2026-07-16T18:01:00.000Z"),
      dailyAttemptCount: 1,
      totalAttemptCount: 1,
    }],
  }];
  const DailyDial = {
    find() {
      return {
        sort() { return this; },
        async lean() { return clone(rows); },
      };
    },
    async updateOne(filter, update) {
      assert.equal(filter._id, "daily-yellow-1");
      rows[0].cadencePersistedAt = update.$set.cadencePersistedAt;
      return { matchedCount: 1 };
    },
  };
  const persist = createPersistDailyDialsToCadence({
    DailyDial,
    recordCadence: async () => ({
      ok: true,
      counted: false,
      skipped: true,
      reason: "cadence-source-missing",
    }),
  });

  const result = await persist({ dateKey: "2026-07-16" });

  assert.deepEqual(result, {
    status: "completed",
    rows: 1,
    persisted: 1,
    attempts: 0,
    skipped: 1,
    skippedRows: 1,
  });
  assert.ok(rows[0].cadencePersistedAt instanceof Date);
});
