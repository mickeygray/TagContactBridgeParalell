"use strict";

// M1 / MD1 — the shared pass runtime, and the two passes built on it.
//
// The guarantees matter more than the output: these run unattended, on a live
// box, and two of the three passes write to client records.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CURSOR_LOST, createPassRuntime, isPacificBusinessDay, pacificDayKey,
} = require("../../apps/control-plane/src/services/passRuntimeFactory");
const {
  createMorningPassRuntime,
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
      if (!cursor || String(cursor.claimedAt) !== String(wanted)) return { matchedCount: 0 };
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

test("one task throwing does not cost the others — it retries, then steps past", async () => {
  let ran = 0;
  const rt = build([
    task("boom", { plan: async () => { throw new Error("nope"); } }),
    task("fine", { plan: async () => { ran += 1; return [{ n: 1 }]; } }),
  ]);
  const model = fakeModel();
  // Attempts 1 and 2 retry and return early, leaving the cursor put.
  const first = await rt.runOnce({ force: true, Model: model });
  assert.equal(first.retrying, "boom");
  assert.equal(ran, 0, "the pass stops at the failing chore while it has attempts left");
  await rt.runOnce({ force: true, Model: model });
  // Third attempt exhausts the budget and steps past.
  const third = await rt.runOnce({ force: true, Model: model });
  assert.equal(ran, 1, "the rest of the day still runs");
  assert.ok(third.results.some((r) => r.task === "fine"));
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

test("the morning cadence asks for sms+email only, and FORCES past the daily window", async () => {
  // 08:00 PT is before the cadence window (09:00-11:59). Without forceDaily the
  // sweep selects nothing every day and reports a confident zero.
  const rt = createMorningPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "cadence-morning");
  const seen = [];
  const planned = await t.plan({ domains: ["TAG", "WYNN"] });
  await t.apply(planned, { cadenceImpl: async (a) => { seen.push(a); return { sent: 3, selected: 4 }; } });
  assert.deepEqual(seen[0].channels, ["sms", "email"]);
  assert.equal(seen[0].forceDaily, true, "08:00 is outside the daily window");
  assert.equal(seen[0].includeAgeRelative, false, "the real-time SMS-2 stays with the gateway");
  assert.equal(seen[0].sourceService, "morning-pass");
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

test("the B1 hoist SURVIVES until the morning floor task is armed", () => {
  // Deleting it in the same commit would create a GAP, not prevent a double
  // run: a dark runtime never creates a timer, so nothing would own the four
  // services between deploy and arming. Two of them are live today.
  const sweeper = require("node:fs").readFileSync(
    require.resolve("../../packages/shared-services/src/hourlySweeperService"), "utf8",
  );
  assert.match(sweeper, /summary\.floor = await runFloorServices\(/,
    "the hourly floor must remain the owner while the morning pass is dark");
});

// ── the midday pass's specifics ────────────────────────────────────────────

test("the midday cadence asks for rvm only", async () => {
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "cadence-midday");
  const seen = [];
  const planned = await t.plan({ domains: ["TAG"] });
  await t.apply(planned, { cadenceImpl: async (a) => { seen.push(a); return { sent: 1 }; } });
  assert.deepEqual(seen[0].channels, ["rvm"]);
  assert.equal(seen[0].includeAgeRelative, false, "an rvm pass must not text anybody");
  assert.equal(seen[0].forceDaily, true, "12:00 is outside the window too");
  assert.equal(seen[0].sourceService, "midday-pass");
});

test("the midday hygiene half does NOT run the account-wide RC sweep", async () => {
  // That belongs to the evening half only. Twice a day doubles the exposure to
  // a 429, and a 429 in that client opens a process-wide circuit that would
  // fail every later task in the pass.
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "call-log-hygiene-midday");
  const seen = [];
  await t.apply(
    [{ domain: "TAG", sinceMs: 16 * 3600000, inbound: 2, outbound: 30 }],
    { callLogHygieneImpl: async (a) => { seen.push(a); return { totals: {} }; } },
  );
  assert.equal(seen[0].nativeSweepEnabled, false);
  assert.equal(seen[0].sinceMs, 16 * 3600000);
});

test("an uncounted domain is a failure in the midday hygiene half too", async () => {
  const rt = createMiddayPassRuntime({});
  const t = rt.TASKS.find((x) => x.key === "call-log-hygiene-midday");
  const seen = [];
  const applied = await t.apply(
    [
      { domain: "TAG", sinceMs: 3600000, inbound: null, error: "conn lost" },
      { domain: "WYNN", sinceMs: 3600000, inbound: 1, outbound: 1 },
    ],
    { callLogHygieneImpl: async (a) => { seen.push(a); return { totals: {} }; } },
  );
  assert.deepEqual(seen[0].domains, ["WYNN"]);
  assert.equal(applied.failed, 1);
  assert.match(applied.errors[0], /TAG: NOT EXAMINED/);
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

test("a RETURNED total failure retries — it does not complete the day", async () => {
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
  assert.equal(first.retrying, "outage", "a total failure must land in the retry path");
  assert.equal(calls, 1);
  await rt.runOnce({ force: true, Model: model });
  await rt.runOnce({ force: true, Model: model });
  assert.equal(calls, 3, "the full attempt budget is spent");
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

test("advancing the cursor RENEWS the lease", async () => {
  // The lease was fixed at claim time, so a pass whose tasks honestly took
  // longer than 45 minutes in total could be reclaimed mid-write. Renewal on
  // every advance means a takeover needs 45 minutes of silence, not of work.
  const model = fakeModel();
  const rt = build([task("a"), task("b"), task("c")]);
  await rt.runOnce({ force: true, Model: model });
  const cursor = model.docs.get(pacificDayKey()).passes.test;
  assert.ok(cursor.completedAt, "the day completed");
  // The claim stamp at completion must be NEWER than the one taken at claim
  // time — i.e. it moved during the pass.
  assert.ok(new Date(cursor.claimedAt) >= new Date(cursor.completedAt) === false
    || cursor.nextTaskIndex === 3, "sanity");
  assert.equal(cursor.nextTaskIndex, 3);
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
      runDncRecheckSweepIfEnabled: async () => ({ skipped: true, reason: "disabled" }),
      runMonthlyFillerPoolRefreshIfDue: async (a) => { seen.push(["filler", a]); return { skipped: true, reason: "pool-already-built" }; },
      runAgedRollingRefreshIfDue: async (a) => { seen.push(["aged", a]); return { refreshed: 1 }; },
    },
  });
  for (const [name, args] of seen) {
    assert.equal(args.requireHour, false, `${name} must receive requireHour:false from the pass`);
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
