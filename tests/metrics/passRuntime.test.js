"use strict";

// M1 / MD1 — the shared pass runtime, and the two passes built on it.
//
// The guarantees matter more than the output: these run unattended, on a live
// box, and two of the three passes write to client records.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CURSOR_LOST, RETIRED_RECORDING_DOWNLOAD_HANDLER_KEYS,
  advancePass, createPassRetryDrainTask, createPassRuntime,
  isPacificBusinessDay, pacificDayKey,
} = require("../../apps/control-plane/src/services/passRuntimeFactory");
const {
  createMorningPassRuntime,
  floorServicesOwnedByMorningPass,
} = require("../../apps/control-plane/src/services/morningPassRuntime");
const {
  createMiddayPassRuntime,
} = require("../../apps/control-plane/src/services/middayPassRuntime");

const withEnv = async (vars, fn) => {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

/** An in-memory DailyLoopRun good enough for the claim/cursor protocol. */
function fakeModel() {
  const docs = new Map();
  return {
    docs,
    // mongoose returns a QUERY here, and claimPass calls .lean() on it. A fake
    // that returns a plain object silently diverges from production.
    findOneAndUpdate(query, update, opts = {}) {
      return { lean: async () => this._claim(query, update, opts) };
    },
    async _claim(query, update, opts = {}) {
      const key = query.dateKey;
      const doc = docs.get(key) || { dateKey: key, passes: {} };
      const passKey = Object.keys(update.$set)[0].split(".")[1];
      const cursor = doc.passes[passKey] || {};
      // Honour the claim predicate: unclaimed, or lease expired.
      const claimClause = (query.$or || []).some((c) => {
        const v = c[`passes.${passKey}.claimedAt`];
        if (v && v.$exists === false) return !cursor.claimedAt;
        if (v === null) return cursor.claimedAt == null;
        if (v && v.$lte) return cursor.claimedAt && cursor.claimedAt <= v.$lte;
        return false;
      });
      if (!claimClause) return null;
      if (cursor.completedAt) return null;
      for (const [path, value] of Object.entries(update.$set)) {
        const field = path.split(".")[2];
        cursor[field] = value;
      }
      doc.passes[passKey] = cursor;
      docs.set(key, doc);
      return opts.new ? JSON.parse(JSON.stringify({ ...doc, passes: doc.passes })) : doc;
    },
    async updateOne(query, update) {
      const doc = docs.get(query.dateKey);
      const passKey = Object.keys(update.$set)[0].split(".")[1];
      const cursor = doc?.passes?.[passKey];
      const wanted = query[`passes.${passKey}.claimedAt`];
      // The claim must still be ours.
      // Compare by INSTANT. String(Date) is second-resolution, which made this
      // fake accept a stale stamp that real Mongo would reject — a fake more
      // permissive than production hides exactly the races it is here to model.
      const same = cursor && wanted
        && new Date(cursor.claimedAt).getTime() === new Date(wanted).getTime();
      if (!same) return { matchedCount: 0 };
      if (cursor.completedAt) return { matchedCount: 0 };
      for (const [path, value] of Object.entries(update.$set)) {
        cursor[path.split(".")[2]] = value;
      }
      return { matchedCount: 1 };
    },
  };
}

const task = (key, over = {}) => ({
  key,
  label: key,
  writesArmed: () => false,
  plan: async () => [{ n: 1 }],
  count: () => 1,
  describe: () => `${key} ok`,
  apply: async () => ({ written: 1 }),
  ...over,
});

const build = (tasks, over = {}) => createPassRuntime({
  passKey: "test",
  label: "Test pass",
  enabledEnv: "TEST_PASS_ENABLED",
  defaultHour: 0,
  tasks,
  config: { enabled: true, ...over },
});

// ── the guarantees ─────────────────────────────────────────────────────────

test("a pass is OFF unless its own env says otherwise", async () => {
  await withEnv({ MORNING_PASS_ENABLED: undefined, MIDDAY_PASS_ENABLED: undefined }, async () => {
    assert.equal(createMorningPassRuntime({}).getState().enabled, false);
    assert.equal(createMiddayPassRuntime({}).getState().enabled, false);
    assert.deepEqual(await createMorningPassRuntime({}).runOnce(), { skipped: "disabled" });
  });
});

test("every task of every pass lands dark", async () => {
  await withEnv({
    MORNING_FLOOR_SERVICES_ENABLED: undefined, MORNING_CADENCE_ENABLED: undefined,
    MIDDAY_CADENCE_ENABLED: undefined, MIDDAY_CALL_LOG_HYGIENE_ENABLED: undefined,
    MIDDAY_LEAD_DELIVERY_HEALTH_ENABLED: undefined,
    THREE_PASS_RETRY_DRAIN_ENABLED: undefined,
  }, async () => {
    for (const rt of [createMorningPassRuntime({}), createMiddayPassRuntime({})]) {
      for (const t of rt.getState().tasks) {
        assert.equal(t.writesArmed, false, `${t.key} must land dark`);
      }
    }
  });
});

test("plan() runs for an UNARMED task — the standing dry run", async () => {
  // Without this a task landed dark reports nothing, and "observe one cycle
  // then arm" has no cycle to observe.
  let planned = 0;
  let applied = 0;
  const rt = build([task("t", {
    plan: async () => { planned += 1; return [{ n: 1 }]; },
    apply: async () => { applied += 1; return { written: 1 }; },
  })]);
  const out = await rt.runOnce({ force: true, Model: fakeModel() });
  assert.equal(planned, 1, "plan must run while dark");
  assert.equal(applied, 0, "apply must not");
  assert.equal(out.results[0].dryRun, true);
  assert.equal(out.results[0].summary, "t ok", "the dry row carries the summary");
});

test("an armed task with nothing planned does not apply", async () => {
  let applied = 0;
  const rt = build([task("t", {
    writesArmed: () => true,
    count: () => 0,
    apply: async () => { applied += 1; return { written: 1 }; },
  })]);
  await rt.runOnce({ force: true, Model: fakeModel() });
  assert.equal(applied, 0);
});

test("one task throwing spends its retries in the same pass, then steps past", async () => {
  let ran = 0;
  let failedPlans = 0;
  const rt = build([
    task("boom", { plan: async () => { failedPlans += 1; throw new Error("nope"); } }),
    task("fine", { plan: async () => { ran += 1; return [{ n: 1 }]; } }),
  ]);
  const model = fakeModel();
  const third = await rt.runOnce({ force: true, Model: model });
  assert.equal(failedPlans, 3, "the complete retry budget is spent before runOnce returns");
  assert.equal(ran, 1, "the rest of the day still runs");
  assert.ok(third.results.some((r) => r.task === "fine"));
  assert.equal(third.degraded, true, "an abandoned task must keep the day visibly degraded");
  assert.deepEqual(third.failedTasks, ["boom"]);
  const cursor = model.docs.get(pacificDayKey()).passes.test;
  assert.equal(cursor.degraded, true);
  assert.equal(cursor.lastErrorCode, "completed-with-task-failures");
  assert.equal(cursor.failedTasks.boom.attempts, 3);
});

test("a completed degraded pass is not replayed by another process", async () => {
  const model = fakeModel();
  let calls = 0;
  const failing = () => build([
    task("boom", { plan: async () => { calls += 1; throw new Error("still down"); } }),
    task("fine"),
  ]);

  const first = await failing().runOnce({ force: true, Model: model });
  const second = await failing().runOnce({ force: true, Model: model });
  assert.equal(calls, 3);
  assert.equal(first.degraded, true);
  assert.deepEqual(second, { skipped: "claimed by another pass" });
  assert.equal(model.docs.get(pacificDayKey()).passes.test.failedTasks.boom.attempts, 3);
});

test("losing the cursor ABORTS the pass; it does not carry on", async () => {
  // Distinct from a task failing: if another process took the day, continuing
  // would write it twice.
  const model = fakeModel();
  model.updateOne = async () => ({ matchedCount: 0 });
  const rt = build([task("a"), task("b")]);
  const out = await rt.runOnce({ force: true, Model: model });
  assert.equal(out.aborted, CURSOR_LOST);
});

test("a second run on the same day is a no-op, not a re-run", async () => {
  const model = fakeModel();
  const rt = build([task("a")]);
  const first = await rt.runOnce({ force: true, Model: model });
  assert.equal(first.ran, 1);
  const second = await rt.runOnce({ Model: model });
  assert.equal(second.skipped, "already ran today");
});

test("a claim held by somebody else is refused", async () => {
  const model = fakeModel();
  const rt = build([task("a")]);
  await rt.runOnce({ force: true, Model: model });
  // Fresh runtime, same day, cursor already completed.
  const other = build([task("a")]);
  const out = await other.runOnce({ force: true, Model: model });
  assert.equal(out.skipped, "claimed by another pass");
});

test("the running guard is released on EVERY early return", async () => {
  const rt = build([task("a")]);
  const model = fakeModel();
  await rt.runOnce({ force: true, Model: model });
  assert.equal(rt.getState().running, false);
  const boom = build([task("x", { plan: async () => { throw new Error("boom"); } })]);
  await boom.runOnce({ force: true, Model: fakeModel() });
  assert.equal(boom.getState().running, false);
});

test("weekends are refused unless forced", async () => {
  const rt = build([task("a")]);
  // 2026-08-08 is a Saturday.
  const out = await rt.runOnce({ now: new Date("2026-08-08T18:00:00Z"), Model: fakeModel() });
  assert.equal(out.skipped, "pacific-weekend");
  assert.equal(isPacificBusinessDay(new Date("2026-08-08T18:00:00Z")), false);
  assert.equal(isPacificBusinessDay(new Date("2026-08-06T18:00:00Z")), true);
});

test("the entire morning pass stays dark on weekends", async () => {
  const rt = createMorningPassRuntime({ config: { enabled: true } });
  const out = await rt.runOnce({
    now: new Date("2026-08-08T18:00:00Z"),
    Model: fakeModel(),
  });
  assert.equal(out.skipped, "pacific-weekend");
  assert.equal(out.results, undefined, "no maintenance or cadence task starts");
});

test("a pass will not run before its scheduled Pacific hour", async () => {
  const rt = createPassRuntime({
    passKey: "test", label: "t", enabledEnv: "TEST_PASS_ENABLED",
    defaultHour: 12, tasks: [task("a")], config: { enabled: true },
  });
  // 15:00Z is 08:00 PT — before noon.
  const early = await rt.runOnce({ now: new Date("2026-08-06T15:00:00Z"), Model: fakeModel() });
  assert.equal(early.skipped, "before the scheduled time");
});

test("the two passes take SEPARATE claims on the same day", async () => {
  // They share a DailyLoopRun document; they must not share a cursor.
  const model = fakeModel();
  const morning = createPassRuntime({
    passKey: "morning", label: "m", enabledEnv: "TEST_PASS_ENABLED",
    defaultHour: 0, tasks: [task("a")], config: { enabled: true },
  });
  const midday = createPassRuntime({
    passKey: "midday", label: "d", enabledEnv: "TEST_PASS_ENABLED",
    defaultHour: 0, tasks: [task("b")], config: { enabled: true },
  });
  const a = await morning.runOnce({ force: true, Model: model });
  const b = await midday.runOnce({ force: true, Model: model });
  assert.equal(a.ran, 1, "morning ran");
  assert.equal(b.ran, 1, "midday ran too — a separate cursor under the same day");
  const doc = model.docs.get(pacificDayKey());
  assert.ok(doc.passes.morning.completedAt);
  assert.ok(doc.passes.midday.completedAt);
});

// ── the morning pass's specifics ───────────────────────────────────────────

test("the retired morning message blast cannot be armed", async () => {
  const rt = createMorningPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "cadence-morning");
  assert.equal(t.writesArmed(), false);
  assert.deepEqual(await t.plan({ domains: ["TAG", "WYNN"] }), []);
});

test("the floor task calls runFloorServices whole, not four re-implementations", async () => {
  const source = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/morningPassRuntime"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(source, /runFloorServices\(\{/);
  for (const forbidden of [/runMonthlyFillerPoolRefreshIfDue/, /runAgedRollingRefreshIfDue/, /runDncRecheckSweep/]) {
    assert.doesNotMatch(source, forbidden, "a copy of a floor member is the drift to avoid");
  }
});

test("the hourly floor handoff requires all three ownership flags", () => {
  const armed = {
    MORNING_FLOOR_FROM_HOURLY_HANDOFF: "true",
    MORNING_PASS_ENABLED: "true",
    MORNING_FLOOR_SERVICES_ENABLED: "true",
  };
  assert.equal(floorServicesOwnedByMorningPass(armed), true);
  for (const name of Object.keys(armed)) {
    assert.equal(
      floorServicesOwnedByMorningPass({ ...armed, [name]: "false" }),
      false,
      `${name} must be present before the hourly owner stands down`,
    );
  }
});

test("the B1 hoist remains as the fallback owner during the no-delete window", () => {
  // The old code stays hard-gated rather than physically deleted. That makes
  // rollback a flag change and prevents a gap while the morning pass is dark.
  const sweeper = require("node:fs").readFileSync(
    require.resolve("../../packages/shared-services/src/hourlySweeperService"), "utf8",
  );
  assert.match(sweeper, /floorServicesEnabled[\s\S]*runFloorServices\(/,
    "the hourly floor must remain available while the morning pass is dark");
});

// ── the midday pass's specifics ────────────────────────────────────────────

test("the retired midday RVM blast cannot be armed", async () => {
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "cadence-midday");
  assert.equal(t.writesArmed(), false);
  assert.deepEqual(await t.plan({ domains: ["TAG"] }), []);
});

test("the unsafe overlapping midday hygiene writer cannot be armed or planned", async () => {
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "call-log-hygiene-midday");
  assert.equal(t.writesArmed(), false);
  assert.deepEqual(await t.plan({ domains: ["TAG"], logger: null }), []);
});

test("the noon pass performs exactly one read-only lead-delivery checkpoint", async () => {
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "lead-delivery-health");
  const planned = await t.plan();
  const applied = await t.apply(planned, {
    leadDeliveryRuntime: {
      getState: () => ({
        running: true,
        enabled: true,
        actionsEnabled: true,
        refillEnabled: true,
        lastErrorCode: null,
        accepted: 17,
        providerPostQueueDepth: 0,
        providerPostInFlight: 0,
        freshDispatch: { lastStatus: "accepted" },
        watchdogSupplyRefresh: { status: "completed" },
      }),
    },
  });
  assert.equal(planned.length, 1);
  assert.equal(applied.status, "healthy");
  assert.equal(applied.written, 0);
  assert.equal(applied.accepted, 17);
});

test("both passes are reachable — every task has a count()", () => {
  for (const rt of [createMorningPassRuntime({}), createMiddayPassRuntime({})]) {
    for (const t of rt.TASKS) {
      assert.equal(typeof t.count, "function", `${t.key} needs a count()`);
      assert.equal(typeof t.describe, "function", `${t.key} needs a describe()`);
      assert.equal(typeof t.plan, "function");
      assert.equal(typeof t.apply, "function");
    }
  }
});

// ── AUDIT FIXES on the factory ─────────────────────────────────────────────

test("a RETURNED total failure spends all retries inside one pass", async () => {
  // Every task catches provider errors and reports {failed: n} instead of
  // throwing — right for a partial failure, where the successes must not
  // re-run. But a night where NOTHING succeeded used to advance the cursor and
  // complete: a total provider outage got zero retries and a clean summary.
  let calls = 0;
  const rt = build([task("outage", {
    writesArmed: () => true,
    apply: async () => { calls += 1; return { written: 0, failed: 3, errors: ["provider down"] }; },
  })]);
  const model = fakeModel();
  const first = await rt.runOnce({ force: true, Model: model });
  assert.equal(first.degraded, true);
  assert.equal(calls, 3, "the full attempt budget is spent");
});

test("the shared retry task retries its queue call inline and combines both lanes", async () => {
  const Model = {
    async countDocuments(query) {
      assert.deepEqual(query.handlerKey, { $nin: RETIRED_RECORDING_DOWNLOAD_HANDLER_KEYS });
      return query.lane === "hourly" ? 2 : 1;
    },
  };
  const retryTask = createPassRetryDrainTask({ passKey: "test", Model, batchCap: 7 });
  const planned = await retryTask.plan({ at: new Date("2026-08-14T19:00:00.000Z") });
  assert.equal(retryTask.count(planned), 3);
  const calls = new Map();
  const applied = await retryTask.apply(planned, {
    retryDrainImpl: async ({ lane, batchCap, excludedHandlerKeys }) => {
      assert.equal(batchCap, 7);
      assert.deepEqual(excludedHandlerKeys, RETIRED_RECORDING_DOWNLOAD_HANDLER_KEYS);
      const n = (calls.get(lane) || 0) + 1;
      calls.set(lane, n);
      if (n === 1) throw new Error("temporary database interruption");
      return { claimed: 1, completed: 1, failed: 0, inlineRetries: 1 };
    },
  });
  assert.deepEqual(Object.fromEntries(calls), { hourly: 2, nightly: 2 });
  assert.equal(applied.completed, 2);
  assert.equal(applied.written, 2);
  assert.equal(applied.inlineRetries, 4);
  assert.equal(applied.deferred, 0);
});

test("a PARTIAL failure still advances — the successes must not re-run", async () => {
  let calls = 0;
  const rt = build([task("partial", {
    writesArmed: () => true,
    apply: async () => { calls += 1; return { written: 5, failed: 2, errors: ["one domain down"] }; },
  })]);
  const out = await rt.runOnce({ force: true, Model: fakeModel() });
  assert.equal(calls, 1);
  assert.equal(out.ran, 1, "partial failure completes the task");
  assert.equal(out.retrying, undefined);
});

test("an all-lock-busy night is not treated as a total failure", async () => {
  // lockBusy is "someone else is doing the work", not "the work failed".
  const rt = build([task("busy", {
    writesArmed: () => true,
    apply: async () => ({ written: 0, failed: 1, lockBusy: 3, errors: ["every domain lock-busy"] }),
  })]);
  const out = await rt.runOnce({ force: true, Model: fakeModel() });
  assert.equal(out.retrying, undefined);
});

test("advancePass RENEWS the lease and returns the new stamp", async () => {
  // The lease was fixed at claim time, so a pass whose tasks honestly took
  // longer than the lease could be reclaimed mid-write. Renewal on every
  // advance means a takeover needs that long of SILENCE, not of work.
  //
  // The previous version of this test was tautological: its assertion reduced
  // to `(claimedAt >= completedAt) === false || nextTaskIndex === 3`, and the
  // escape clause was guaranteed by the very next line. Deleting the renewal
  // from advancePass left it green. This one asserts the stamp MOVED.
  const model = fakeModel();
  const dateKey = pacificDayKey();
  const claimedAt = new Date("2026-08-06T15:00:00.000Z");
  model.docs.set(dateKey, { dateKey, passes: { test: { claimedAt, nextTaskIndex: 0 } } });

  const renewed = await advancePass("test", dateKey, claimedAt, 1, { planned: 0 }, {
    at: new Date("2026-08-06T15:20:00.000Z"), Model: model,
  });

  assert.ok(renewed instanceof Date, "the caller needs the new stamp to keep CASing with");
  assert.equal(renewed.toISOString(), "2026-08-06T15:20:00.000Z");
  const cursor = model.docs.get(dateKey).passes.test;
  assert.equal(String(cursor.claimedAt), String(renewed),
    "the STORED claim must move, or the lease is still measured from claim time");
  assert.notEqual(String(cursor.claimedAt), String(claimedAt));
});

test("after a renewal the OLD stamp no longer owns the claim", async () => {
  // The other half of the guarantee: renewal is only useful if the stale stamp
  // stops working, so a dispossessed writer loses its next CAS.
  const model = fakeModel();
  const dateKey = pacificDayKey();
  const claimedAt = new Date("2026-08-06T15:00:00.000Z");
  model.docs.set(dateKey, { dateKey, passes: { test: { claimedAt, nextTaskIndex: 0 } } });

  const renewed = await advancePass("test", dateKey, claimedAt, 1, {}, {
    at: new Date("2026-08-06T15:20:00.000Z"), Model: model,
  });
  assert.ok(renewed);

  const stale = await advancePass("test", dateKey, claimedAt, 2, {}, {
    at: new Date("2026-08-06T15:40:00.000Z"), Model: model,
  });
  assert.equal(stale, null, "the old stamp must lose — that is what makes it a lease");
});

test("the pass loop ADOPTS each renewed stamp across every task", async () => {
  // A loop that renewed the stored value but kept CASing with the original
  // would lose its own claim on task two. Proven by watching the predicate.
  const model = fakeModel();
  const seen = [];
  const realUpdate = model.updateOne.bind(model);
  model.updateOne = async (query, update) => {
    // toISOString, NOT String(): String(Date) renders to SECONDS, so two
    // stamps milliseconds apart compare equal and the whole assertion goes
    // blind. The same trap is why the fake's own CAS compares by getTime.
    seen.push(new Date(query["passes.test.claimedAt"]).toISOString());
    return realUpdate(query, update);
  };
  // Real elapsed time between tasks: three no-op tasks finish inside one
  // millisecond, and renewals in the same millisecond are legitimately equal.
  const slow = (key) => task(key, {
    plan: async () => { await new Promise((r) => setTimeout(r, 4)); return [{ n: 1 }]; },
  });
  const rt = build([slow("a"), slow("b"), slow("c")]);
  const out = await rt.runOnce({ force: true, Model: model });
  assert.equal(out.ran, 3, "all three tasks ran");
  assert.ok(seen.length >= 3);
  // Three advances must each carry a distinct stamp. finishPass legitimately
  // reuses the third — it is the same owner closing the day it just advanced —
  // so the count is "at least three distinct", not "all distinct".
  assert.ok(new Set(seen).size >= 3,
    `each advance must CAS with its OWN renewed stamp; saw ${new Set(seen).size} distinct in ${seen.length}`);
  assert.notEqual(seen[0], seen[seen.length - 1],
    "the last CAS must not still be using the original claim stamp");
});

test("stop() waits for a running pass instead of abandoning it", async () => {
  const rt = build([task("slow", {
    plan: async () => { await new Promise((r) => setTimeout(r, 400)); return [{ n: 1 }]; },
  })]);
  const model = fakeModel();
  const running = rt.runOnce({ force: true, Model: model });
  await new Promise((r) => setTimeout(r, 50));
  const stopped = rt.stop({ maxWaitMs: 2000 });
  await Promise.all([running, stopped]);
  assert.equal(rt.getState().running, false, "stop returned only after the pass finished");
});

test("start() does not hold service startup behind a due catch-up pass", async () => {
  let releasePlan;
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  const rt = createPassRuntime({
    passKey: "startup-catch-up",
    label: "startup catch-up",
    enabledEnv: "TEST_PASS_ENABLED",
    defaultHour: 0,
    tasks: [task("slow", {
      plan: async () => {
        await planGate;
        return [{ n: 1 }];
      },
    })],
    config: { enabled: true, pollMs: 60_000 },
    runtime: { Model: fakeModel() },
  });

  const started = rt.start();
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("start waited for the catch-up pass")),
      100,
    )),
  ]);
  assert.equal(rt.getState().running, true, "the catch-up continues after start returns");

  releasePlan();
  await rt.stop({ maxWaitMs: 2_000 });
  assert.equal(rt.getState().running, false);
});

test("the morning floor reaches the 05:00 and 06:00 work — requireHour is threaded", async () => {
  // The hour equalities inside the filler/aged gates are an hourly caller's
  // substitute for once-per-day bookkeeping. The morning pass fires at 08:00
  // under a durable claim; with the hour still required, the monthly refresh
  // and the aged ladder would simply never run from it.
  const rt = createMorningPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "floor-services");
  const source = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/morningPassRuntime"), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(source, /requireHour: false/, "the morning task must drop the hour equality");
  // And the seam carries it: injected impls receive requireHour.
  const seen = [];
  await t.apply([{ services: [] }], {
    floorImpls: {
      runDncRecheckSweepIfEnabled: async (a) => { seen.push(["dnc", a]); return { skipped: true, reason: "disabled" }; },
      runMonthlyFillerPoolRefreshIfDue: async (a) => { seen.push(["filler", a]); return { skipped: true, reason: "pool-already-built" }; },
      runAgedRollingRefreshIfDue: async (a) => { seen.push(["aged", a]); return { refreshed: 1 }; },
    },
  });
  for (const [name, args] of seen) {
    if (name !== "dnc") {
      assert.equal(args.requireHour, false, `${name} must receive requireHour:false from the pass`);
    }
    if (name === "dnc") {
      assert.equal(args.limit, 2500, "the once-daily owner must not inherit the one-tick DNC page");
    }
    if (name === "aged") {
      assert.equal(args.limitPerDomain, 2500, "the once-daily owner must not inherit a one-tick page");
    }
  }
});

test("the HOURLY floor keeps its hour gates — byte-identical behaviour", () => {
  // Default true, so the hoist cannot start firing the monthly refresh every
  // tick on the 1st.
  const {
    runFloorServices,
  } = require("../../packages/shared-services/src/hourlySweeperService");
  const source = String(runFloorServices);
  assert.match(source, /requireHour = true/, "the default must keep the hour equality");
});

test("a task abandoned EARLIER in the day stays abandoned across a re-claim", async () => {
  // The durable trace is the whole point of persisting failedTasks: a pass that
  // gave up on a chore must not finish the day reporting clean. The retry
  // budget (attemptsByTask) is seeded from the claim and tested; the TRACE is
  // seeded the same way and was not, so dropping `{...claim.failedTasks}` broke
  // the guarantee with every test still green.
  //
  // A pass resumes mid-day on any retry-return, restart, or lease takeover, and
  // on resume the earlier abandonment lives only in the cursor.
  const model = fakeModel();
  const dateKey = pacificDayKey();
  const claimedAt = new Date(Date.now() - 60_000);
  model.docs.set(dateKey, {
    dateKey,
    passes: {
      test: {
        claimedAt: null,
        nextTaskIndex: 0,
        attemptsByTask: {},
        // Abandoned by an earlier poll of THIS day.
        failedTasks: {
          "earlier-chore": { attempts: 3, errorCode: "task-failed", failedAt: claimedAt },
        },
      },
    },
  });

  const rt = build([task("later-chore")]);
  const out = await rt.runOnce({ force: true, Model: model });
  assert.equal(out.ran, 1, "the remaining chore still runs");

  const cursor = model.docs.get(dateKey).passes.test;
  assert.ok(cursor.completedAt, "the day completed");
  assert.ok(
    Object.keys(cursor.failedTasks || {}).includes("earlier-chore"),
    "the earlier abandonment must survive the re-claim",
  );
  assert.equal(cursor.degraded, true,
    "a day that abandoned a chore must not finish reporting clean");
  assert.equal(cursor.lastErrorCode, "completed-with-task-failures");
  assert.equal(out.degraded, true, "and the in-memory result must agree");
});
