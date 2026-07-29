"use strict";

// Sheet-triggered end-of-day loop (build-up work order F1.1).
//
// Mickey: "I'll pull both payment sheets at 6 pm and upload them, you'll
// pull both activities when you get both the payment sheets and run the
// loop." So the activities pull is triggered by the GATE going ready, not
// by a clock — and it must fire EXACTLY ONCE per day no matter how many
// uploads, retries, or process restarts happen.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { DailyLoopRun } = require("../../packages/shared-models/src");
const loop = require("../../packages/shared-services/src/dailyLoopService");

const DAY = "2026-07-27";

// Minimal in-memory stand-in for the per-day guard document.
function fakeGuard() {
  const store = new Map();
  const original = DailyLoopRun.findOneAndUpdate;
  DailyLoopRun.findOneAndUpdate = async (filter) => {
    const key = filter.dateKey;
    // The real filter requires activitiesFiredAt null/absent — model that.
    if (store.has(key)) return null;
    store.set(key, { dateKey: key, activitiesFiredAt: new Date() });
    return store.get(key);
  };
  return {
    restore() { DailyLoopRun.findOneAndUpdate = original; },
    size() { return store.size; },
  };
}

function stubUpdateOne() {
  const original = DailyLoopRun.updateOne;
  DailyLoopRun.updateOne = async () => ({ acknowledged: true });
  return () => { DailyLoopRun.updateOne = original; };
}

test("does not fire while the gate is not ready", async () => {
  const guard = fakeGuard();
  const restoreUpdate = stubUpdateOne();
  let ran = 0;
  try {
    const out = await loop.triggerActivitiesIfSheetsReady({
      dateKey: DAY,
      readGate: async () => ({ ready: false, missing: ["WYNN"] }),
      runActivities: async () => { ran += 1; return {}; },
    });
    assert.equal(out.fired, false);
    assert.equal(out.reason, "gate-not-ready");
    assert.deepEqual(out.missing, ["WYNN"]);
    assert.equal(ran, 0, "activities must not run on a half-uploaded day");
  } finally { guard.restore(); restoreUpdate(); }
});

test("fires once when the gate flips ready", async () => {
  const guard = fakeGuard();
  const restoreUpdate = stubUpdateOne();
  let ran = 0;
  try {
    const out = await loop.triggerActivitiesIfSheetsReady({
      dateKey: DAY,
      triggeredBy: "WYNN",
      readGate: async () => ({ ready: true }),
      runActivities: async () => { ran += 1; return { processed: { statusChangeCounts: { dnc: 4, postdate: 7, casesChanged: 61 } } }; },
    });
    assert.equal(out.fired, true);
    assert.equal(ran, 1);
  } finally { guard.restore(); restoreUpdate(); }
});

test("a THIRD upload does not re-fire the same day", async () => {
  const guard = fakeGuard();
  const restoreUpdate = stubUpdateOne();
  let ran = 0;
  const call = () => loop.triggerActivitiesIfSheetsReady({
    dateKey: DAY,
    readGate: async () => ({ ready: true }),
    runActivities: async () => { ran += 1; return {}; },
  });
  try {
    const first = await call();
    const second = await call();
    const third = await call();
    assert.equal(first.fired, true);
    assert.equal(second.fired, false);
    assert.equal(second.reason, "already-ran-today");
    assert.equal(third.fired, false);
    assert.equal(ran, 1, "exactly one activities pull per day");
  } finally { guard.restore(); restoreUpdate(); }
});

test("concurrent uploads race at the DB — only one wins", async () => {
  const guard = fakeGuard();
  const restoreUpdate = stubUpdateOne();
  let ran = 0;
  try {
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      loop.triggerActivitiesIfSheetsReady({
        dateKey: DAY,
        readGate: async () => ({ ready: true }),
        runActivities: async () => { ran += 1; return {}; },
      })));
    assert.equal(results.filter((r) => r.fired).length, 1, "exactly one winner");
    assert.equal(ran, 1);
  } finally { guard.restore(); restoreUpdate(); }
});

// ── the claim is a LEASE with expiry (pipeline contract, invariant 11) ───
// A hard process crash executes no catch, so a stamped claim with no
// completed day-doc must become reclaimable — without this an nssm restart
// mid-pass silently loses the night (adversarial finding, 2026-07-27).

function fakeLeaseGuard(doc) {
  const store = new Map(doc ? [["2026-07-27", doc]] : []);
  const original = DailyLoopRun.findOneAndUpdate;
  DailyLoopRun.findOneAndUpdate = async (filter) => {
    const cur = store.get(filter.dateKey);
    const clauses = filter.$or || [];
    const leaseClause = clauses.find((c) => c.activitiesFiredAt?.$lt);
    const cutoff = leaseClause ? leaseClause.activitiesFiredAt.$lt : null;
    const matches = !cur
      || cur.activitiesFiredAt == null
      || (cutoff && cur.activitiesFiredAt < cutoff && cur.dayDocCompletedAt == null);
    if (!matches) return null;
    store.set(filter.dateKey, { ...(cur || {}), dateKey: filter.dateKey, activitiesFiredAt: new Date() });
    return store.get(filter.dateKey);
  };
  return { restore() { DailyLoopRun.findOneAndUpdate = original; }, store };
}

test("an EXPIRED claim with no completed day-doc is reclaimable", async () => {
  const guard = fakeLeaseGuard({
    activitiesFiredAt: new Date(Date.now() - 60 * 60 * 1000),   // stamped an hour ago
    dayDocCompletedAt: null,                                    // …but the night never finished
  });
  try {
    assert.equal(await loop.claimActivitiesRun({ dateKey: "2026-07-27" }), true,
      "a crashed pass must not permanently burn the night");
  } finally { guard.restore(); }
});

test("a FRESH claim is not reclaimable — mutual exclusion holds mid-pass", async () => {
  const guard = fakeLeaseGuard({
    activitiesFiredAt: new Date(Date.now() - 5 * 60 * 1000),    // five minutes ago
    dayDocCompletedAt: null,
  });
  try {
    assert.equal(await loop.claimActivitiesRun({ dateKey: "2026-07-27" }), false);
  } finally { guard.restore(); }
});

test("a COMPLETED night is never reclaimable, however old", async () => {
  const guard = fakeLeaseGuard({
    activitiesFiredAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    dayDocCompletedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
  });
  try {
    assert.equal(await loop.claimActivitiesRun({ dateKey: "2026-07-27" }), false,
      "once-per-day stays absolute for finished work");
  } finally { guard.restore(); }
});

test("a duplicate-key collision counts as 'already ran', not an error", async () => {
  const original = DailyLoopRun.findOneAndUpdate;
  DailyLoopRun.findOneAndUpdate = async () => {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  };
  try {
    assert.equal(await loop.claimActivitiesRun({ dateKey: DAY }), false);
  } finally { DailyLoopRun.findOneAndUpdate = original; }
});

test("an activities failure NEVER throws into the upload handler", async () => {
  const guard = fakeGuard();
  const restoreUpdate = stubUpdateOne();
  try {
    const out = await loop.triggerActivitiesIfSheetsReady({
      dateKey: DAY,
      readGate: async () => ({ ready: true }),
      runActivities: async () => { throw new Error("Logics is down"); },
    });
    assert.equal(out.fired, false);
    assert.equal(out.reason, "error");
    assert.match(out.error, /Logics is down/);
  } finally { guard.restore(); restoreUpdate(); }
});

test("a gate failure also never throws", async () => {
  const guard = fakeGuard();
  try {
    const out = await loop.triggerActivitiesIfSheetsReady({
      dateKey: DAY,
      readGate: async () => { throw new Error("mongo unavailable"); },
      runActivities: async () => ({}),
    });
    assert.equal(out.fired, false);
    assert.equal(out.reason, "error");
  } finally { guard.restore(); }
});

test("summarizeActivitiesResult keeps counts, drops the bulky payload", () => {
  const small = loop.summarizeActivitiesResult({
    domains: ["TAG", "WYNN"],
    processed: {
      parsedRows: 5000,
      statusChangeCounts: { dnc: 4, postdate: 7, casesChanged: 61, changes: new Array(500) },
      collapsedRows: new Array(900),
    },
  });
  assert.deepEqual(small.statusChangeCounts, { dnc: 4, postdate: 7, casesChanged: 61 });
  assert.equal(small.parsedRows, 5000);
  assert.ok(!("collapsedRows" in small), "bulky rows must not be stored on the guard doc");
});

// ── the scheduled tick waits for the sheets ───────────────────────────────
// Mickey: "the service depends on the presence of the sheets to run ... if
// it's not uploaded by this time don't do it at this time."

test("scheduled tick WAITS when the sheets are not up yet", () => {
  // Every pre-deadline hour waits, whether or not it also nags.
  for (const hourNow of [18, 19, 20, 21, 22]) {
    const d = loop.decideScheduledActivitiesRun({ gateReady: false, hourNow, reminderHour: 20, deadlineHour: 23 });
    assert.equal(d.run, false, `${hourNow}:00 must not run without sheets`);
    assert.match(d.reason, /^waiting/, `${hourNow}:00 reason should be a waiting state`);
  }
});

test("scheduled tick runs the moment the sheets are up", () => {
  const d = loop.decideScheduledActivitiesRun({ gateReady: true, hourNow: 20, deadlineHour: 23 });
  assert.equal(d.run, true);
  assert.equal(d.ranWithoutSheets, false);
});

test("a LATE upload still gets a full loop (21:00, sheets now up)", () => {
  // The 20:00 tick waited without consuming the day, so the 21:00 tick runs.
  assert.equal(loop.decideScheduledActivitiesRun({ gateReady: false, hourNow: 20, deadlineHour: 23 }).run, false);
  assert.equal(loop.decideScheduledActivitiesRun({ gateReady: true, hourNow: 21, deadlineHour: 23 }).run, true);
});

test("no nag before the reminder hour — 18:00 and 19:00 are silent waiting", () => {
  for (const hourNow of [18, 19]) {
    const d = loop.decideScheduledActivitiesRun({ gateReady: false, hourNow, reminderHour: 20, deadlineHour: 23 });
    assert.equal(d.remind, false, `${hourNow}:00 must not nag`);
    assert.equal(d.run, false);
  }
});

test("nags at the reminder hour when the sheet is still missing", () => {
  const d = loop.decideScheduledActivitiesRun({ gateReady: false, hourNow: 20, reminderHour: 20, deadlineHour: 23 });
  assert.equal(d.remind, true);
  assert.equal(d.run, false, "the nag does not itself start the run");
});

test("never nags once the reminder already went out", () => {
  // The tick asks every 60s from 20:00 to 23:00. Without this, 180 emails.
  for (const hourNow of [20, 21, 22]) {
    const d = loop.decideScheduledActivitiesRun({
      gateReady: false, hourNow, reminderHour: 20, deadlineHour: 23, reminderAlreadySent: true,
    });
    assert.equal(d.remind, false, `${hourNow}:00 must stay silent after the first nag`);
  }
});

test("never nags when the sheets ARE up", () => {
  const d = loop.decideScheduledActivitiesRun({ gateReady: true, hourNow: 21, reminderHour: 20, deadlineHour: 23 });
  assert.equal(d.remind, false, "nagging Mickey for something he already did is the worst outcome");
  assert.equal(d.run, true);
});

test("no second email at the deadline — the run already reports sheetlessness", () => {
  const d = loop.decideScheduledActivitiesRun({ gateReady: false, hourNow: 23, reminderHour: 20, deadlineHour: 23 });
  assert.equal(d.remind, false);
  assert.equal(d.run, true);
});

test("reminders can be switched off entirely without affecting the run", () => {
  const d = loop.decideScheduledActivitiesRun({
    gateReady: false, hourNow: 21, reminderHour: 20, deadlineHour: 23, remindersEnabled: false,
  });
  assert.equal(d.remind, false);
  assert.equal(d.run, false, "silencing the nag must not silence the loop");
});

test("past the deadline, safety work still runs — flagged as sheetless", () => {
  // Standing rule: the payments gate holds MONEY, never safety work. The
  // DNC / post-date pull is not sheet-derived, so it must not be lost.
  const d = loop.decideScheduledActivitiesRun({ gateReady: false, hourNow: 23, deadlineHour: 23 });
  assert.equal(d.run, true);
  assert.equal(d.ranWithoutSheets, true, "the day must be legible as having run without sheets");
});

test("sheets present at the deadline are NOT flagged sheetless", () => {
  const d = loop.decideScheduledActivitiesRun({ gateReady: true, hourNow: 23, deadlineHour: 23 });
  assert.equal(d.ranWithoutSheets, false);
});

test("both hours are env-overridable and clamped to a real hour", () => {
  const vars = [
    ["LOGICS_ACTIVITY_REVIEW_SHEET_DEADLINE_HOUR", () => loop.sheetDeadlineHour(), 23],
    ["LOGICS_ACTIVITY_REVIEW_SHEET_REMINDER_HOUR", () => loop.sheetReminderHour(), 20],
  ];
  for (const [name, read, dflt] of vars) {
    const prev = process.env[name];
    try {
      delete process.env[name];
      assert.equal(read(), dflt, `${name} default`);
      process.env[name] = "21";
      assert.equal(read(), 21);
      process.env[name] = "99";
      assert.equal(read(), 23, "clamped high");
      process.env[name] = "-4";
      assert.equal(read(), 0, "clamped low");
      process.env[name] = "nonsense";
      assert.equal(read(), dflt, "falls back, never NaN");
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  }
});

test("a NaN hour never silently becomes a run — the guard is numeric", () => {
  // hourNow arrives from Intl formatting; if that ever yields junk we must
  // not accidentally satisfy `hour >= deadline` and fire a sheetless pull.
  const d = loop.decideScheduledActivitiesRun({
    gateReady: false, hourNow: Number.NaN, reminderHour: 20, deadlineHour: 23,
  });
  assert.equal(d.run, false, "NaN comparisons are false — must land in waiting");
  assert.equal(d.remind, false);
});

// ── regression: the poll must not wedge the runtime ───────────────────────
// An adversarial review found `state.running` was set BEFORE the wait-for-
// sheets guard and only cleared in a `finally` the guard's early return
// never reached. First poll latched it true, and every later tick
// short-circuited on `if (state.running) return` — so the sheets could land
// and nothing would ever fire. The fix hoists the guard above the flag.
// This test pins the ORDER in the source so it cannot silently regress.
test("the wait-for-sheets guard runs BEFORE state.running is set", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    require("node:path").join(__dirname, "../../apps/control-plane/src/services/logicsActivityReviewRuntime.js"),
    "utf8",
  );
  const guardAt = src.indexOf("THE LOOP WAITS FOR THE SHEETS");
  const runningAt = src.indexOf("state.running = true");
  const startedStageAt = src.indexOf('stage: "requested"');
  assert.ok(guardAt > 0 && runningAt > 0, "both markers must exist");
  assert.ok(
    guardAt < runningAt,
    "the poll guard must precede `state.running = true`, or a waiting tick latches the flag forever",
  );
  assert.ok(
    guardAt < startedStageAt,
    "a poll must not emit a 'started' workflow stage — 180 ticks would write 180 events",
  );
});

test("a failed run RELEASES the day so the deadline can still run it", async () => {
  const store = new Map([["2026-07-27", { activitiesFiredAt: new Date() }]]);
  const origFind = DailyLoopRun.findOneAndUpdate;
  const origUpdate = DailyLoopRun.updateOne;
  DailyLoopRun.findOneAndUpdate = async (filter) => {
    const cur = store.get(filter.dateKey);
    if (cur?.activitiesFiredAt) return null;
    store.set(filter.dateKey, { activitiesFiredAt: new Date() });
    return store.get(filter.dateKey);
  };
  DailyLoopRun.updateOne = async (filter, update) => {
    if (update?.$set && "activitiesFiredAt" in update.$set) {
      store.set(filter.dateKey, { activitiesFiredAt: update.$set.activitiesFiredAt });
    }
    return { acknowledged: true };
  };
  try {
    store.set("2026-07-27", { activitiesFiredAt: null });
    const out = await loop.triggerActivitiesIfSheetsReady({
      dateKey: "2026-07-27",
      readGate: async () => ({ ready: true }),
      runActivities: async () => { throw new Error("Logics 500"); },
    });
    assert.equal(out.fired, false);
    assert.equal(
      store.get("2026-07-27").activitiesFiredAt, null,
      "a burned day means the night silently produces nothing — the claim is a lease, not a tombstone",
    );
  } finally { DailyLoopRun.findOneAndUpdate = origFind; DailyLoopRun.updateOne = origUpdate; }
});

test("triggerActivitiesAsync returns immediately", () => {
  const out = loop.triggerActivitiesAsync({
    dateKey: DAY,
    readGate: async () => ({ ready: false }),
  });
  assert.deepEqual(out, { scheduled: true });
});
