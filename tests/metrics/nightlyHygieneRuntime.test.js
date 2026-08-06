"use strict";

// The single nightly service. Its guards matter more than its output: it runs
// unattended, on a live box, against live client records.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createNightlyHygieneRuntime, isPacificBusinessDay, persistTargetDay,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");
const { DailyLoopRun } = require("../../packages/shared-models/src");

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

const taskByKey = (state, key) => state.tasks.find((t) => t.key === key);

test("disabled by default — deploying the code does not start writing", async () => {
  await withEnv({
    NIGHTLY_HYGIENE_ENABLED: undefined,
    LOGICS_SOURCE_WRITER_ENABLED: undefined,
    NIGHT_PERSIST_ENABLED: undefined,
    // Armed in this box's .env on 2026-08-03. The test asserts what a FRESH
    // deploy does, so every writer flag has to be cleared here — otherwise
    // this stops testing the default and starts testing the local machine.
    MAIL_INVOICE_MAILBOX_ENABLED: undefined,
    MAIL_SPEND_DERIVE_ENABLED: undefined,
    // The mailbox task now arms on EITHER document, so NCOA's flag has to be
    // cleared here too or this test reads the local box instead of the default.
    NCOA_MAILBOX_ENABLED: undefined,
  }, async () => {
    const rt = createNightlyHygieneRuntime({});
    const s = rt.getState();
    assert.equal(s.enabled, false);
    for (const t of s.tasks) {
      assert.equal(t.writesArmed, false, `${t.key} must not be armed by default`);
      assert.equal(t.mode, "off");
    }
    assert.deepEqual(await rt.runOnce(), { skipped: "disabled" });
  });
});

test("the attribution-persist task is registered and independently gated", () => {
  // It is the only writer of officerAtSale/sourceAtSale. Losing it loses data
  // permanently, so it gets its own switch rather than riding another task's.
  const s = createNightlyHygieneRuntime({}).getState();
  const persist = taskByKey(s, "night-persist");
  assert.ok(persist, "night-persist must be registered");
  assert.match(persist.label, /attribution/i);
  assert.notEqual(persist.key, taskByKey(s, "logics-source")?.key);
});

test("the running guard is released by EVERY early return", async () => {
  // A runtime on this box wedged permanently because its `finally` belonged to
  // a different `try`, so one early return left running=true forever.
  const rt = createNightlyHygieneRuntime({});
  await rt.runOnce();
  assert.equal(rt.getState().running, false, "wedged — the exact bug from last time");
});

test("scheduled hygiene is dormant on Pacific weekends", () => {
  assert.equal(isPacificBusinessDay(new Date("2026-08-02T16:00:00.000Z")), false);
  assert.equal(isPacificBusinessDay(new Date("2026-08-03T16:00:00.000Z")), true);
});

test("an unarmed task still discovers under a durable daily claim", async () => {
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async () => ({ dateKey: "2026-08-03" });
  DailyLoopRun.updateOne = async () => ({ acknowledged: true });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    let planned = 0;
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "disabled", label: "disabled", writesArmed: () => false,
      plan: async () => { planned += 1; return []; },
      apply: async () => ({}), describe: () => "",
    });
    const result = await rt.runOnce({ at: new Date("2026-08-03T20:00:00Z") });
    // THE STANDING DRY RUN. plan() is read-only, so an unarmed task still runs
    // it and still reports what it WOULD have done — that report is the only
    // evidence the "land dark, observe one cycle, then arm" discipline has.
    assert.equal(planned, 1, "an unarmed task must still plan");
    assert.equal(result.tasks[0].dryRun, true);
    assert.equal(result.tasks[0].reason, "standing-dry-run");
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("scheduled hygiene stops at a failed task and leaves its durable cursor retryable", async () => {
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  const writes = [];
  const claimedAt = new Date("2026-08-04T03:00:00Z");
  DailyLoopRun.findOneAndUpdate = async () => ({
    dateKey: "2026-08-03", nightlyHygieneClaimedAt: claimedAt, nightlyHygieneNextTaskIndex: 0,
  });
  DailyLoopRun.updateOne = async (filter, update) => {
    writes.push({ filter, update });
    return { acknowledged: true, matchedCount: 1 };
  };
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    let laterPlans = 0;
    rt.TASKS.length = 0;
    rt.TASKS.push(
      {
        key: "failed", label: "failed", writesArmed: () => true,
        plan: async () => { throw new Error("bounded task failed"); },
        apply: async () => ({}), describe: () => "",
      },
      {
        key: "later", label: "later", writesArmed: () => true,
        plan: async () => { laterPlans += 1; return []; },
        apply: async () => ({}), describe: () => "",
      },
    );
    const result = await rt.runOnce({ at: claimedAt });
    assert.equal(result.incomplete, true);
    assert.equal(result.nextTaskIndex, 0);
    assert.equal(laterPlans, 0);
    assert.equal(rt.getState().lastRunKey, null);
    assert.ok(writes.some((row) => row.update.$set?.nightlyHygieneClaimedAt === null));
    assert.ok(!writes.some((row) => row.update.$set?.nightlyHygieneCompletedAt));
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("scheduled hygiene resumes from the durable task cursor after restart", async () => {
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  const claimedAt = new Date("2026-08-04T03:00:00Z");
  DailyLoopRun.findOneAndUpdate = async () => ({
    dateKey: "2026-08-03", nightlyHygieneClaimedAt: claimedAt, nightlyHygieneNextTaskIndex: 1,
  });
  DailyLoopRun.updateOne = async () => ({ acknowledged: true, matchedCount: 1 });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    const planned = [];
    rt.TASKS.length = 0;
    rt.TASKS.push(
      {
        key: "already-done", label: "already done", writesArmed: () => true,
        plan: async () => { planned.push("already-done"); return []; },
        apply: async () => ({}), describe: () => "",
      },
      {
        key: "resume-here", label: "resume here", writesArmed: () => true,
        plan: async () => { planned.push("resume-here"); return []; },
        apply: async () => ({}), describe: () => "",
      },
    );
    const result = await rt.runOnce({ at: claimedAt });
    assert.deepEqual(planned, ["resume-here"]);
    assert.equal(result.incomplete, undefined);
    assert.equal(rt.getState().lastRunKey, "2026-08-03");
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("running the loop is a SEPARATE decision from letting it write", async () => {
  // Enabled + writer disarmed is a standing dry-run: the plan is visible, and
  // nothing reaches a live client record.
  await withEnv({ NIGHTLY_HYGIENE_ENABLED: "true", LOGICS_SOURCE_WRITER_ENABLED: undefined }, () => {
    const s = createNightlyHygieneRuntime({}).getState();
    assert.equal(s.enabled, true);
    assert.equal(taskByKey(s, "logics-source").writesArmed, false);
    assert.equal(taskByKey(s, "logics-source").mode, "standing dry-run");
  });
  await withEnv({ NIGHTLY_HYGIENE_ENABLED: "true", LOGICS_SOURCE_WRITER_ENABLED: "true" }, () => {
    const s = createNightlyHygieneRuntime({}).getState();
    assert.equal(taskByKey(s, "logics-source").mode, "writing");
    // Arming one task must never arm another.
    assert.equal(taskByKey(s, "night-persist").writesArmed, false);
  });
});

test("a task that throws does not cost the other tasks their night", async () => {
  const rt = createNightlyHygieneRuntime({ config: { enabled: true } });
  const ran = [];
  rt.TASKS.length = 0;
  rt.TASKS.push(
    { key: "boom", label: "explodes", writesArmed: () => false,
      plan: async () => { throw new Error("upstream on fire"); },
      apply: async () => ({}), describe: () => "" },
    { key: "fine", label: "works", writesArmed: () => false,
      plan: async () => { ran.push("fine"); return [{ plan: [] }]; },
      apply: async () => ({}), describe: () => "ok" },
  );
  const result = await rt.runOnce({ force: true });
  assert.deepEqual(ran, ["fine"], "the healthy task still ran");
  assert.match(result.tasks[0].error, /upstream on fire/);
  assert.equal(result.tasks[1].error, undefined);
});

test("a completed pass claims the day; a failed one does not", async () => {
  const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
  rt.TASKS.length = 0;
  rt.TASKS.push({
    key: "noop", label: "noop", writesArmed: () => false,
    plan: async () => [{ plan: [] }], apply: async () => ({}), describe: () => "nothing to do",
  });
  await rt.runOnce({ force: true });
  const key = rt.getState().lastRunKey;
  assert.ok(key, "a completed pass records the Pacific day");
  // Without force, the same day must not run twice — this is what survives a
  // control-plane restart, unlike an in-memory flag.
  assert.deepEqual(await rt.runOnce(), { skipped: "already ran today" });
});

test("apply=false forces a dry run even when the writer is armed", async () => {
  await withEnv({ LOGICS_SOURCE_WRITER_ENABLED: "true" }, async () => {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true } });
    let applied = false;
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "t", label: "t", writesArmed: () => true,
      plan: async () => [{ plan: [{ caseId: 1 }] }],
      apply: async () => { applied = true; return { written: 1 }; },
      describe: () => "1",
    });
    const r = await rt.runOnce({ force: true, apply: false });
    assert.equal(applied, false, "an explicit apply:false must beat the env switch");
    assert.equal(r.tasks[0].dryRun, true);
  });
});

test("a non-row plan actually reaches apply()", async () => {
  const rt = createNightlyHygieneRuntime({ config: { enabled: true } });
  let applied = false;
  rt.TASKS.length = 0;
  rt.TASKS.push({
    key: "counter-shaped", label: "counter-shaped", writesArmed: () => true,
    plan: async () => [{ counters: { rows: 5 } }],
    count: (planned) => planned[0].counters.rows,
    apply: async () => { applied = true; return { written: 5 }; },
    describe: () => "5",
  });
  await rt.runOnce({ force: true });
  assert.equal(applied, true, "count() must drive the apply decision");
});

// ── the defects an adversarial review found, each of which failed SILENTLY ──

test("the evening pass targets the day that just finished selling", () => {
  // Mickey 2026-07-28: "source the deals, gather the call urls, create the
  // night report for spend, honor any custom reports, wait til 7:50."
  // At 19:50 PT the current Pacific day IS that day — the same assumption the
  // 20:20 board always made. The hour and the day-offset must agree: an
  // early-hours run would need -1, and pairing hour=02 with offset 0 was the
  // defect that silently persisted two hours of overnight noise.
  const at1950PT = new Date("2026-07-29T02:50:00Z");   // 19:50 PT on 7/28
  assert.equal(persistTargetDay(at1950PT), "2026-07-28");
});

test("the offset stays configurable so hour and day can never drift apart", () => {
  const prior = process.env.NIGHT_PERSIST_DAY_OFFSET;
  process.env.NIGHT_PERSIST_DAY_OFFSET = "-1";
  try {
    // Moved back to the early hours, -1 restores the completed day.
    assert.equal(persistTargetDay(new Date("2026-07-29T09:30:00Z")), "2026-07-28");
  } finally {
    if (prior === undefined) delete process.env.NIGHT_PERSIST_DAY_OFFSET;
    else process.env.NIGHT_PERSIST_DAY_OFFSET = prior;
  }
});

test("hygiene runs BEFORE the 20:20 board, with headroom", () => {
  // The order is the requirement: attribution must be sourced before any
  // report reads it, or the board shows tonight's deals unattributed.
  const s = createNightlyHygieneRuntime({}).getState();
  const hygiene = s.hour * 60 + s.minute;
  assert.equal(hygiene, 19 * 60 + 50, "19:50 PT");
  assert.ok(hygiene < 20 * 60 + 20, "must finish before the night board fires");
  assert.ok((20 * 60 + 20) - hygiene >= 30, "at least half an hour of headroom");
});

test("all three tenants persist by default, not TAG alone", () => {
  // runNightPass defaults to TAG/WYNN/AMITY. Defaulting this runtime to TAG
  // silently dropped two thirds of the tenants' activity events and payment
  // truths, with no error and no missing-data signal.
  const s = createNightlyHygieneRuntime({}).getState();
  assert.deepEqual(s.domains, ["TAG", "WYNN", "AMITY"]);
});

test("the persist task counts PENDING WRITES, not activity rows", () => {
  // count() drives whether apply() runs at all. Counting `counters.rows`
  // meant a night with rows but nothing new to persist looked like work,
  // and — worse — the 02:00 empty pull made rows 0 so apply() never ran.
  const rt = createNightlyHygieneRuntime({});
  const persist = rt.TASKS.find((t) => t.key === "night-persist");
  assert.equal(persist.count([{ pending: { events: [1, 2, 3], truths: [4, 5] } }]), 5);
  assert.equal(persist.count([{ pending: { events: [], truths: [] }, counters: { rows: 9999 } }]), 0,
    "9,999 rows with nothing to write is nothing to do");
});

test("apply persists exactly what plan derived — no second pass", async () => {
  // Re-running the whole pass with apply:true resolved attribution a SECOND
  // time, so the numbers written were not the numbers reported, and a lookup
  // that succeeded in plan() but failed in apply() would persist a weaker
  // snapshot than the one just shown.
  const rt = createNightlyHygieneRuntime({});
  const persist = rt.TASKS.find((t) => t.key === "night-persist");
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8",
  );
  const applyBody = src.slice(src.indexOf("async apply(planned"), src.indexOf("count(planned)"));
  assert.ok(!applyBody.includes("runNightPass"),
    "apply() must not re-run the gather; it persists plan()'s pending writes");
  assert.ok(applyBody.includes("persistPaymentTruths") && applyBody.includes("insertActivityEvents"),
    "apply() must call the persist helpers directly");
  assert.equal(typeof persist.apply, "function");
});

test("describe reports deals from lanes, not a counter that never existed", () => {
  const rt = createNightlyHygieneRuntime({});
  const persist = rt.TASKS.find((t) => t.key === "night-persist");
  const line = persist.describe([{
    dateKey: "2026-07-28",
    counters: { rows: 2240 },
    pending: { events: [1, 2], truths: [3] },
    night: { lanes: { deals: [{}, {}, {}, {}, {}] } },
  }]);
  assert.match(line, /2026-07-28/);
  assert.match(line, /5 deal\(s\)/, "deals live on night.lanes.deals, not counters.deals");
  assert.match(line, /2 event\(s\) \+ 1 payment truth\(s\)/);
});

test("the night runs in the stated ORDER", () => {
  // Mickey 2026-07-28: "source the deals, gather the call urls, create the
  // night report for spend, honor any custom reports, wait til 7:50."
  // Sourcing must precede the report; the call-url pass must precede it too,
  // or the board links calls whose URLs were attached a minute later.
  const s2 = createNightlyHygieneRuntime({}).getState();
  // queue-rollup freezes the day's per-agent counts so a RANGE never has to
  // ask RingCentral; it sits with the other capture steps, before the report.
  //
  // call-recovery-discovery sits directly after call-links because both read
  // the SAME completed day out of the one CallRail account — keeping them
  // adjacent is what stops a future edit from putting a recovery read on a
  // different day boundary than the link capture that describes it.
  //
  // mail-invoice sits AFTER night-persist and not first. It is a network-bound
  // mailbox read, so it is the task most able to stall; night-persist writes
  // officerAtSale/sourceAtSale, which is the one thing here that cannot be
  // recovered later. The irreplaceable write goes before the stallable read.
  //
  // mail-spend-derive follows mail-invoice directly, so a day's invoice can
  // arrive and become spend in the SAME pass, ten minutes before the board
  // reads it. It is armed separately because reading the mailbox and believing
  // the number are different decisions.
  //
  // Mickey 2026-08-04: "one build of the data layer (call links, costing,
  // activity review => daily snapshot => result email)." spend-sync (costing)
  // and activity-review were separate timers at 19:45 and 20:00; folding them
  // in put them BEFORE the thing that reads them instead of beside it.
  //
  // There is deliberately NO daily-snapshot task. A task receives no report, so
  // its only possible body was a second live composeReport at 19:50 — a whole
  // extra gather, which is the opposite of "one shot and just branch". The
  // branch lives in reportDefinitionService, which already composes once and
  // hands that same report to captureDeliveredDailyFact.
  // call-recording-index is LAST: it reads what the day produced across every
  // provider, so it wants the rest of the pass to have finished correcting data
  // first. It is also the only task whose output is a new collection rather
  // than a fix to an existing one.
  assert.deepEqual(s2.tasks.map((t) => t.key),
    ["night-persist", "mail-invoice", "mail-spend-derive", "call-links", "call-recovery-discovery",
      "call-recovery-eligibility-hygiene", "queue-rollup", "logics-source", "spend-sync",
      "activity-review", "call-recording-index"]);
  assert.ok(!s2.tasks.some((t) => t.key === "daily-snapshot"),
    "the snapshot is NOT a hygiene task — it branches off the report's own single gather");

  // Every folded-in task must be REACHABLE. A task with no count() plans an
  // empty set, so plannedCount is 0 and apply() is never called — arming its
  // flag would produce a silently successful no-op pass.
  // Assert against the real task objects, not getState()'s projection — the
  // projection does not carry count(), so checking it there passes vacuously.
  // TASKS lives on the runtime INSTANCE (each instance owns its own copy), not
  // on the module.
  const instance = createNightlyHygieneRuntime({});
  for (const key of ["call-recovery-discovery", "spend-sync", "activity-review"]) {
    const task = instance.TASKS.find((t) => t.key === key);
    assert.ok(task, `${key} must be registered`);
    assert.equal(typeof task.count, "function",
      `${key} must implement count(), or plannedCount is 0 and apply() never runs`);
    assert.ok(task.count([{}]) > 0, `${key}.count() must report work to do`);
  }
  const recovery = instance.TASKS.find((t) => t.key === "call-recovery-discovery");
  assert.equal(recovery.count([{ qualified: 0, errors: 0 }]), 1,
    "a legitimately empty completed day still needs one daily cohort manifest");
});

test("call-links CAPTURES marketing links; PhoneBurner still cannot", () => {
  // Superseded the monitor: CallRail links ARE fetchable one call at a time,
  // so they get pooled. PhoneBurner sessions remain unreachable for the
  // service account, so those URLs can only come from forward capture.
  const rt = createNightlyHygieneRuntime({});
  const task = rt.TASKS.find((t) => t.key === "call-links");
  assert.ok(task, "call-links must be registered");
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8",
  );
  const body = src.slice(src.indexOf('key: "call-links"'), src.indexOf('key: "queue-rollup"'));
  assert.ok(body.includes("marketingCallLinkService"), "must use the link pool service");
  assert.ok(!body.includes("backfillRecordingUrls"), "must not call the impossible PhoneBurner backfill");
});

test("call-links counts MARKETING calls, not every call", () => {
  // Live 2026-07-27: 91 calls, 83 marketing, 8 servicing. Counting all 91
  // would make the task claim work it will not do.
  const rt = createNightlyHygieneRuntime({});
  const task = rt.TASKS.find((t) => t.key === "call-links");
  assert.equal(task.count([{ calls: 91, marketing: 83, servicing: 8 }]), 83);
  assert.equal(task.count([{ calls: 0, marketing: 0 }]), 0);
  assert.match(
    task.describe([{ dateKey: "2026-07-27", calls: 91, marketing: 83, withRecording: 83, alreadyHad: 0 }]),
    /83 marketing/,
  );
});

test("every task is gated by its OWN switch", () => {
  // Arming one must never arm another: they write to different systems, and
  // logics-source writes to LIVE CLIENT RECORDS.
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8",
  );
  // Every WRITING task has its own flag. The monitor has none on purpose —
  // it cannot write, so a switch would imply a capability it lacks.
  for (const flag of ["NIGHT_PERSIST_ENABLED", "CALL_LINK_CAPTURE_ENABLED", "QUEUE_ROLLUP_ENABLED", "LOGICS_SOURCE_WRITER_ENABLED"]) {
    assert.ok(src.includes(flag), `${flag} must gate its task`);
  }
  const rt = createNightlyHygieneRuntime({});
  for (const t of rt.TASKS) {
    if (t.monitor) assert.equal(t.writesArmed(), false, `${t.key} is a monitor and must never arm`);
  }
  const s2 = createNightlyHygieneRuntime({}).getState();
  assert.equal(new Set(s2.tasks.map((t) => t.key)).size, s2.tasks.length, "no duplicate task keys");
});

test("a chore that keeps failing is retried, then stepped past so the night finishes", async () => {
  // The old behaviour aborted the pass on EVERY failure while a durable claim
  // was held — so one flaky chore took every task behind it, every poll,
  // forever. The new behaviour has to thread a needle: retry (because
  // night-persist writes officerAtSale, which a live re-pull can never
  // reconstruct, so a transient blip must not skip it) but bounded (because the
  // 20:00 email needs the costing that sits behind it).
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  const claimedAt = new Date("2026-08-04T03:00:00Z");
  let cursor = 0;
  DailyLoopRun.findOneAndUpdate = async () => ({
    dateKey: "2026-08-03", nightlyHygieneClaimedAt: claimedAt, nightlyHygieneNextTaskIndex: cursor,
  });
  DailyLoopRun.updateOne = async (filter, update) => {
    const next = update.$set?.nightlyHygieneNextTaskIndex;
    if (typeof next === "number") cursor = next;
    return { acknowledged: true, matchedCount: 1 };
  };
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    let healthyRuns = 0;
    rt.TASKS.length = 0;
    rt.TASKS.push(
      // Armed on purpose. Unarmed would now plan too (the standing dry run),
      // but an unarmed task never reaches apply() — and the retry behaviour
      // under test is about a task that is genuinely trying to do work.
      { key: "flaky", label: "flaky", writesArmed: () => true,
        plan: async () => { throw new Error("provider unavailable"); },
        apply: async () => ({}), describe: () => "" },
      { key: "healthy", label: "healthy", writesArmed: () => true,
        plan: async () => { healthyRuns += 1; return [{ plan: [] }]; },
        apply: async () => ({}), describe: () => "ok" },
    );

    // Polls 1 and 2: the flaky task is retried in place, cursor does not move,
    // and the healthy task behind it has not run yet.
    for (const attempt of [1, 2]) {
      const r = await rt.runOnce({ at: claimedAt });
      assert.equal(r.retrying, "flaky", `poll ${attempt} should still be retrying`);
      assert.equal(r.attempt, attempt);
      assert.equal(cursor, 0, "the cursor stays on the failing task while retries remain");
      assert.equal(healthyRuns, 0, "downstream work waits during the retry window");
    }

    // Poll 3 exhausts the attempts: the pass steps past the flaky chore and the
    // rest of the night finally runs.
    const final = await rt.runOnce({ at: claimedAt });
    assert.equal(final.retrying, undefined, "no longer retrying once attempts are spent");
    assert.equal(healthyRuns, 1, "the healthy task runs after the flaky one is abandoned");
    assert.equal(final.tasks[0].skippedAfterAttempts, 3, "the skip is recorded, not silent");
    assert.match(final.tasks[0].error, /provider unavailable/);
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("an unarmed task plans but never applies", async () => {
  // The contract at the top of the registry says plan() is "read-only; always
  // safe, always run, so `lastRun` shows the work even when the task may not
  // write." The loop used to skip plan() entirely for unarmed tasks, which made
  // every dark task report planned:0 and left arming decisions blind.
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async () => ({ dateKey: "2026-08-03" });
  DailyLoopRun.updateOne = async () => ({ acknowledged: true });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    let plans = 0; let applies = 0;
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "dark", label: "dark", writesArmed: () => false,
      plan: async () => { plans += 1; return [{ plan: [1, 2, 3] }]; },
      apply: async () => { applies += 1; return { written: 3 }; },
      describe: () => "would do three things",
    });
    const result = await rt.runOnce({ at: new Date("2026-08-03T20:00:00Z") });
    assert.equal(plans, 1, "plan runs exactly once");
    assert.equal(applies, 0, "apply must never run unarmed");
    assert.equal(result.tasks[0].planned, 3, "the dark task reports real work");
    assert.equal(result.tasks[0].summary, "would do three things");
    assert.equal(rt.getState().totals.planned, 3, "dark work counts toward the pass total");
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("an armed task with nothing planned does not apply", async () => {
  // The count() trap: a task whose count is 0 must not call apply(). This is the
  // guard that made spend-sync silently no-op when it had no count() at all.
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async () => ({ dateKey: "2026-08-03" });
  DailyLoopRun.updateOne = async () => ({ acknowledged: true });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    let applies = 0;
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "empty", label: "empty", writesArmed: () => true,
      plan: async () => [{ plan: [] }],
      apply: async () => { applies += 1; return { written: 0 }; },
      describe: () => "nothing to do",
    });
    const result = await rt.runOnce({ at: new Date("2026-08-03T20:00:00Z") });
    assert.equal(applies, 0);
    assert.equal(result.tasks[0].planned, 0);
    assert.equal(result.tasks[0].dryRun, false, "armed is armed even with nothing to do");
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("a dark task whose plan throws is a task failure, not a silent skip", async () => {
  // Consequence of always planning: a dark task with a broken read side now
  // surfaces. That is the point — a task that cannot even look should be
  // visible before somebody arms it.
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async () => ({ dateKey: "2026-08-03" });
  DailyLoopRun.updateOne = async () => ({ acknowledged: true, matchedCount: 1 });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "darkbroken", label: "darkbroken", writesArmed: () => false,
      plan: async () => { throw new Error("logics unreachable"); },
      apply: async () => ({}), describe: () => "",
    });
    const result = await rt.runOnce({ at: new Date("2026-08-03T20:00:00Z") });
    const row = result.tasks[0];
    assert.ok(row.error, "the failure is reported rather than swallowed");
    assert.match(row.error, /logics unreachable/);
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("losing the cursor on a DARK task aborts the pass, it does not retry", async () => {
  // A lost cursor means another pass re-claimed the day. Continuing would let two
  // passes write the same night, which is why the armed path aborts on it.
  // The dark branch used to throw a plain Error with no CURSOR_LOST code, so the
  // catch treated it as an ordinary task failure and retried — the one case where
  // the guard silently did not apply.
  const originalFind = DailyLoopRun.findOneAndUpdate;
  const originalUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async () => ({ dateKey: "2026-08-03" });
  // matchedCount 0 = the claim is gone.
  DailyLoopRun.updateOne = async () => ({ acknowledged: true, matchedCount: 0 });
  try {
    const rt = createNightlyHygieneRuntime({ config: { enabled: true, hour: 0 } });
    rt.TASKS.length = 0;
    rt.TASKS.push({
      key: "dark", label: "dark", writesArmed: () => false,
      plan: async () => [{ plan: [] }], apply: async () => ({}), describe: () => "",
    });
    const result = await rt.runOnce({ at: new Date("2026-08-03T20:00:00Z") });
    assert.equal(result.aborted, "durable-cursor-lost");
    assert.notEqual(result.retrying, "dark", "a lost cursor must not be retried");
  } finally {
    DailyLoopRun.findOneAndUpdate = originalFind;
    DailyLoopRun.updateOne = originalUpdate;
  }
});

test("activity-review reports the counts the service actually returns", async () => {
  // It used to read r.written / r.reviewed, neither of which the service returns —
  // so a full night's review reported written: 0 and the summary said nothing
  // happened. The real counts live under `processed`.
  const s = createNightlyHygieneRuntime({}).getState();
  const task = createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === "activity-review");
  assert.ok(task, "activity-review must be registered");
  const applied = await task.apply([{ dateKey: "2026-08-05" }], {
    activityReviewRuntime: {
      runActivityReview: async () => ({
        processed: {
          parsedRows: 5, outputRows: 3, suspendedOutputRows: 1,
          aiReview: { reviewedCases: 2 }, suspendedAiReview: { reviewedCases: 1 },
        },
      }),
    },
  });
  assert.equal(applied.written, 4, "3 notice + 1 suspended rows written");
  assert.equal(applied.reviewed, 3, "2 + 1 cases reviewed by AI");
  assert.equal(applied.rows, 5, "5 activity rows parsed");
  assert.equal(applied.failed, 0);
  assert.ok(s, "state readable");
});

test("activity-review with no runtime injected is a failure, not a silent zero", async () => {
  const task = createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === "activity-review");
  const applied = await task.apply([{ dateKey: "2026-08-05" }], {});
  assert.equal(applied.failed, 1);
  assert.equal(applied.written, 0);
});

// ── E9: NCOA FOLDED INTO THE MAILBOX VISIT ─────────────────────────────────
//
// NCOA had its own hourly trigger in server.js. It now rides the nightly
// mailbox task, which is the only change that makes "get into the mailbox
// once" true. The risk of that fold is a SILENT OUTAGE: NCOA answering to a
// flag it no longer sees, on a host whose .env is not this box's. These tests
// pin the two places that could drop it.

test("the mailbox visit carries the NCOA handler when NCOA is enabled", () => {
  const { buildMailboxHandlers } = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");
  const keys = buildMailboxHandlers({ ncoaEnabled: true, targetDate: "2026-08-06" }).map((h) => h.key);
  assert.deepEqual(keys, ["mail-invoice", "ncoa"], "one visit reads both documents");
});

test("NCOA keeps its own flag — disabled means the handler is absent, not idle", () => {
  const { buildMailboxHandlers } = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");
  const keys = buildMailboxHandlers({ ncoaEnabled: false, targetDate: "2026-08-06" }).map((h) => h.key);
  assert.deepEqual(keys, ["mail-invoice"], "folding the job must not arm it where it was off");
});

test("the two handlers cannot fight over one message", () => {
  // The invoice accepts on PDF content, NCOA on .csv/.txt extension. If that
  // ever overlapped, one email would be processed twice by two writers.
  const { buildMailboxHandlers } = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");
  const [invoice, ncoa] = buildMailboxHandlers({ ncoaEnabled: true, targetDate: "2026-08-06" });
  const csv = [{ filename: "ncoa-returns.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") }];
  assert.equal(ncoa.accepts(csv, { message: {} }), true, "NCOA takes the csv");
  assert.equal(
    invoice.accepts(csv, { message: { payload: { headers: [] } } }),
    false,
    "the invoice reader must not take a csv",
  );
});

test("either document arms the mailbox visit — NCOA alone is enough", async () => {
  // The handover's real hazard. NCOA was armed by NCOA_MAILBOX_ENABLED; if the
  // folded task armed only on MAIL_INVOICE_MAILBOX_ENABLED, then any host with
  // the invoice reader dark would have stopped running NCOA the night this
  // shipped, and nothing would have said so.
  await withEnv({
    MAIL_INVOICE_MAILBOX_ENABLED: "false",
    NCOA_MAILBOX_ENABLED: "true",
  }, async () => {
    const task = createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === "mail-invoice");
    assert.equal(task.writesArmed(), true, "NCOA alone must open the mailbox");
  });

  await withEnv({
    MAIL_INVOICE_MAILBOX_ENABLED: "true",
    NCOA_MAILBOX_ENABLED: undefined,
  }, async () => {
    const task = createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === "mail-invoice");
    assert.equal(task.writesArmed(), true, "the invoice alone still opens it");
  });

  await withEnv({
    MAIL_INVOICE_MAILBOX_ENABLED: undefined,
    NCOA_MAILBOX_ENABLED: undefined,
  }, async () => {
    const task = createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === "mail-invoice");
    assert.equal(task.writesArmed(), false, "neither wanted — do not open it");
  });
});

test("the mailbox task counts NCOA's work, not only the invoice's", async () => {
  // A night that filed 40 NCOA returns and found no invoice reported written: 0.
  // Both handlers write; both have to be visible in the totals, or the nightly
  // summary understates what happened.
  const rt = createNightlyHygieneRuntime({});
  const task = rt.TASKS.find((t) => t.key === "mail-invoice");
  const source = String(task.apply);
  assert.match(source, /handlers\.ncoa/, "apply must read the ncoa handler's stat");
  assert.match(source, /ncoa\.processed/, "and add its processed count to written");
});
