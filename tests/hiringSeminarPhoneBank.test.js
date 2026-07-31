"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TARGET_NAMES,
  cancelCalls,
  buildScheduleSlots,
  execute,
  resolveTargets,
  runCycle,
} = require("../scripts/run-hiring-seminar-phone-bank");

const TARGET_EXTENSION_NUMBERS = Object.freeze([
  "1105",
  "1106",
  "987",
  "1103",
]);

function fakeDirectoryClient(overrides = {}) {
  const extensions = TARGET_NAMES.map((name, index) => ({
    id: `ext-${index + 1}`,
    name,
    status: "Enabled",
    type: "User",
    extensionNumber: TARGET_EXTENSION_NUMBERS[index],
  }));
  return {
    listExtensions: async () => ({ records: extensions }),
    listExtensionPhoneNumbers: async (extensionId) => {
      const index = Number(extensionId.split("-").pop());
      return {
        records: [
          {
            usageType: "DirectNumber",
            primary: true,
            phoneNumber: `+12135550${String(index).padStart(3, "0")}`,
          },
          {
            usageType: "DirectNumber",
            primary: false,
            phoneNumber: "+12135559999",
          },
        ],
      };
    },
    listAccountPhoneNumbers: async () => ({
      records: [{ phoneNumber: "+12135550100" }],
    }),
    createRingOut: async () => ({ id: "unused" }),
    deleteRingOut: async () => ({}),
    ...overrides,
  };
}

function onceOptions(overrides = {}) {
  return {
    apply: false,
    dryRun: true,
    once: true,
    date: "",
    startTime: "",
    endTime: "",
    times: [],
    timeZone: "America/Los_Angeles",
    intervalMinutes: 10,
    ringSeconds: 20,
    staggerMs: 0,
    lateToleranceSeconds: 60,
    toPhone: "+12135550100",
    ...overrides,
  };
}

test("resolves the four exact monitor names to unique primary DirectNumbers", async () => {
  const targets = await resolveTargets(fakeDirectoryClient());
  assert.deepEqual(targets.map((target) => target.label), TARGET_NAMES);
  assert.equal(new Set(targets.map((target) => target.extensionId)).size, 4);
  assert.equal(new Set(targets.map((target) => target.fromPhone)).size, 4);
});

test("fails closed when a required exact extension is missing", async () => {
  const client = fakeDirectoryClient({
    listExtensions: async () => ({
      records: TARGET_NAMES.slice(0, 3).map((name, index) => ({
        id: `ext-${index + 1}`,
        name,
        status: "Enabled",
        type: "User",
        extensionNumber: TARGET_EXTENSION_NUMBERS[index],
      })),
    }),
  });
  await assert.rejects(
    resolveTargets(client),
    /Anthony Monitor must resolve to exactly one enabled User extension/,
  );
});

test("fails closed when a monitor has ambiguous primary DirectNumbers", async () => {
  const client = fakeDirectoryClient({
    listExtensionPhoneNumbers: async () => ({
      records: [
        {
          usageType: "DirectNumber",
          primary: true,
          phoneNumber: "+12135550001",
        },
        {
          usageType: "DirectNumber",
          primary: true,
          phoneNumber: "+12135550002",
        },
      ],
    }),
  });
  await assert.rejects(resolveTargets(client), /exactly one primary DirectNumber/);
});

test("dry-run resolves and plans but creates and deletes no RingOut calls", async () => {
  let creates = 0;
  let deletes = 0;
  const client = fakeDirectoryClient({
    createRingOut: async () => {
      creates += 1;
      return { id: "should-not-run" };
    },
    deleteRingOut: async () => {
      deletes += 1;
    },
  });
  const output = [];
  const result = await execute({
    client,
    options: onceOptions(),
    nowFn: () => new Date("2026-07-25T16:00:00.000Z"),
    sleepFn: async () => {},
    write: (value) => output.push(value),
  });
  assert.equal(result.dryRun, true);
  assert.equal(creates, 0);
  assert.equal(deletes, 0);
  assert.match(output.join(""), /"targets":\["James Monitor","Brad Monitor","Voicemail One","Anthony Monitor"\]/);
  assert.doesNotMatch(output.join(""), /\+1213/);
});

test("one live cycle creates four calls and cleans up all four", async () => {
  const created = [];
  const deleted = [];
  const client = fakeDirectoryClient({
    createRingOut: async (extensionId) => {
      created.push(extensionId);
      return { id: `ring-${created.length}` };
    },
    deleteRingOut: async (extensionId, ringOutId) => {
      deleted.push([extensionId, ringOutId]);
    },
  });
  const targets = await resolveTargets(client);
  const output = [];
  const result = await runCycle({
    client,
    targets,
    toPhone: "+12135550100",
    ringSeconds: 1,
    staggerMs: 0,
    activeCalls: [],
    sleepFn: async () => {},
    write: (value) => output.push(value),
    authorized: true,
  });
  assert.equal(result.acceptedCount, 4);
  assert.equal(created.length, 4);
  assert.equal(deleted.length, 4);
  assert.doesNotMatch(output.join(""), /\+1213|ext-|ring-/);
});

test("a partial create failure cleans up earlier accepted calls and aborts", async () => {
  let creates = 0;
  const deleted = [];
  const client = fakeDirectoryClient({
    createRingOut: async () => {
      creates += 1;
      if (creates === 2) {
        const error = new Error("provider details must not be logged");
        error.status = 503;
        error.code = "provider_unavailable";
        throw error;
      }
      return { id: `ring-${creates}` };
    },
    deleteRingOut: async (extensionId, ringOutId) => {
      deleted.push([extensionId, ringOutId]);
    },
  });
  const targets = await resolveTargets(client);
  const output = [];
  await assert.rejects(
    runCycle({
      client,
      targets,
      toPhone: "+12135550100",
      ringSeconds: 1,
      staggerMs: 0,
      activeCalls: [],
      sleepFn: async () => {},
      write: (value) => output.push(value),
      authorized: true,
    }),
    /provider details must not be logged/,
  );
  assert.equal(deleted.length, 1);
  assert.doesNotMatch(output.join(""), /provider details must not be logged|\+1213|ext-|ring-/);
  assert.match(output.join(""), /provider_unavailable/);
});

test("live execution refuses to mutate without apply authorization", async () => {
  let creates = 0;
  const client = fakeDirectoryClient({
    createRingOut: async () => {
      creates += 1;
      return { id: "should-not-run" };
    },
  });
  await assert.rejects(
    execute({
      client,
      options: onceOptions({ apply: false, dryRun: false }),
      nowFn: () => new Date("2026-07-25T16:00:00.000Z"),
      sleepFn: async () => {},
      write: () => {},
    }),
    /requires apply authorization/,
  );
  assert.equal(creates, 0);
});

test("failed cancellation identity is retained for a final retry", async () => {
  let failFirstDelete = true;
  const activeCalls = [];
  const client = fakeDirectoryClient({
    createRingOut: async (extensionId) => ({ id: `ring-${extensionId}` }),
    deleteRingOut: async (extensionId) => {
      if (extensionId === "ext-1" && failFirstDelete) {
        failFirstDelete = false;
        const error = new Error("temporary delete failure");
        error.status = 503;
        error.code = "temporary_delete_failure";
        throw error;
      }
    },
  });
  const targets = await resolveTargets(client);
  await assert.rejects(
    runCycle({
      client,
      targets,
      toPhone: "+12135550100",
      ringSeconds: 1,
      staggerMs: 0,
      activeCalls,
      sleepFn: async () => {},
      write: () => {},
      authorized: true,
    }),
    /could not be cancelled/,
  );
  assert.equal(activeCalls.length, 1);
  const retry = await cancelCalls(client, activeCalls, () => {});
  assert.equal(retry.length, 1);
  assert.equal(retry[0].ok, true);
  assert.equal(activeCalls.length, 0);
});

test("a late start catches up only the newest eligible past slot", async () => {
  let creates = 0;
  const client = fakeDirectoryClient({
    createRingOut: async () => {
      creates += 1;
      return { id: `ring-${creates}` };
    },
  });
  const output = [];
  const result = await execute({
    client,
    options: onceOptions({
      apply: true,
      dryRun: false,
      once: false,
      date: "2026-07-25",
      times: ["09:00", "09:01", "09:02"],
      ringSeconds: 1,
      lateToleranceSeconds: 600,
    }),
    nowFn: () => new Date("2026-07-25T16:02:30.000Z"),
    sleepFn: async () => {},
    write: (value) => output.push(value),
  });
  assert.equal(result.completedCycles, 1);
  assert.equal(result.skippedCycles, 2);
  assert.equal(creates, 4);
  assert.equal(output.join("").match(/past_before_start/g)?.length, 2);
});
test("window scheduling uses Pacific wall clock and excludes the end boundary", () => {
  const options = onceOptions({
    once: false,
    date: "2026-07-25",
    startTime: "09:00",
    endTime: "09:31",
    intervalMinutes: 10,
  });
  const slots = buildScheduleSlots(options, new Date("2026-07-25T00:00:00.000Z"));
  assert.deepEqual(
    slots.map((slot) => slot.toISOString()),
    [
      "2026-07-25T16:00:00.000Z",
      "2026-07-25T16:10:00.000Z",
      "2026-07-25T16:20:00.000Z",
      "2026-07-25T16:30:00.000Z",
    ],
  );
});

test("explicit times reject overlapping ring cycles", () => {
  const options = onceOptions({
    once: false,
    date: "2026-07-25",
    times: ["09:00", "09:01"],
    ringSeconds: 90,
    staggerMs: 0,
  });
  assert.throws(
    () => buildScheduleSlots(options, new Date("2026-07-25T00:00:00.000Z")),
    /overlap/,
  );
});
