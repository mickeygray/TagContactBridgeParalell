"use strict";

// The single nightly service. Its guards matter more than its output: it runs
// unattended, on a live box, against live client records.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createNightlyHygieneRuntime, persistTargetDay,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");

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
  assert.deepEqual(s2.tasks.map((t) => t.key),
    ["night-persist", "call-urls", "queue-rollup", "logics-source"]);
});

test("call-urls is a WATCH, not a backfill — backfill is impossible", () => {
  // Mickey 2026-07-28: "we wont be able to backfill so only forward looking
  // post patch will we have phone burner urls." Confirmed live: the service
  // account cannot enumerate agent-owned sessions, so the backfill indexed 0
  // sessions on every day tried. Shipping it would have meant a task that
  // reports "0 to attach" forever and looks healthy doing it.
  const rt = createNightlyHygieneRuntime({});
  const task = rt.TASKS.find((t) => t.key === "call-urls");
  assert.equal(task.monitor, true);
  assert.equal(task.writesArmed(), false, "a monitor can never be armed");
  assert.equal(task.count([{ attempts: 900, withUrl: 0 }]), 0, "count 0 keeps apply unreachable");
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8",
  );
  const body = src.slice(src.indexOf('key: "call-urls"'), src.indexOf('key: "logics-source"'));
  assert.ok(!body.includes("backfillRecordingUrls"), "must not call the impossible backfill");
  assert.ok(!/callrail/i.test(body), "CallRail is pulled live, never copied into our store");
});

test("the monitor says out loud when capture stops landing", () => {
  // The real silent failure: dials keep being logged while the URLs quietly
  // stop. Measured 2026-07-28: 0 of 1,789 attempts carried one.
  const rt = createNightlyHygieneRuntime({});
  const task = rt.TASKS.find((t) => t.key === "call-urls");
  assert.match(task.describe([{ dateKey: "2026-07-28", attempts: 1789, withUrl: 0 }]),
    /0\/1789 attempt\(s\) carry a recording URL \(0%\) — capture is not landing/);
  assert.match(task.describe([{ dateKey: "2026-07-29", attempts: 100, withUrl: 100 }]), /100%/);
  assert.ok(!task.describe([{ dateKey: "2026-07-29", attempts: 100, withUrl: 100 }]).includes("not landing"));
  assert.match(task.describe([{ dateKey: "2026-07-30", attempts: 0, withUrl: 0 }]), /no dials recorded/);
});

test("a monitor is labelled as one, not as a dry-run waiting to be armed", () => {
  const s2 = createNightlyHygieneRuntime({ config: { enabled: true } }).getState();
  const t = s2.tasks.find((x) => x.key === "call-urls");
  assert.equal(t.mode, "monitor (never writes)");
});

test("every task is gated by its OWN switch", () => {
  // Arming one must never arm another: they write to different systems, and
  // logics-source writes to LIVE CLIENT RECORDS.
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8",
  );
  // Every WRITING task has its own flag. The monitor has none on purpose —
  // it cannot write, so a switch would imply a capability it lacks.
  for (const flag of ["NIGHT_PERSIST_ENABLED", "LOGICS_SOURCE_WRITER_ENABLED"]) {
    assert.ok(src.includes(flag), `${flag} must gate its task`);
  }
  const rt = createNightlyHygieneRuntime({});
  for (const t of rt.TASKS) {
    if (t.monitor) assert.equal(t.writesArmed(), false, `${t.key} is a monitor and must never arm`);
  }
  const s2 = createNightlyHygieneRuntime({}).getState();
  assert.equal(new Set(s2.tasks.map((t) => t.key)).size, s2.tasks.length, "no duplicate task keys");
});
