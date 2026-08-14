"use strict";

// E8 — CALL LOG HYGIENE, EVENING HALF.
//
// Mickey 2026-08-06: "call log hygiene could be the thing thats split between 1
// and 7." This is the 7 o'clock half.
//
// The window is the substance of this step, not a scheduling detail. The
// service filters on `callStartTime` with a 65-minute default, and the only
// feed still producing rows — PhoneBurner — is projected off a CLOSED DailyDial
// date, so its rows appear an average of 5.4 hours after the call started. A
// 65-minute window can never see them. Measured 2026-08-06: 0 rows in 65
// minutes, 947 in 24 hours.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createNightlyHygieneRuntime, pacificMsSinceToday,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");

const task = () => createNightlyHygieneRuntime({}).TASKS
  .find((t) => t.key === "call-log-hygiene-evening");

const hours = (ms) => ms / 3600000;

// ── the window helper ──────────────────────────────────────────────────────

test("ms-since-noon-PT is computed from Pacific wall clock, not a UTC offset", () => {
  // August, so PDT = UTC-7.
  assert.equal(hours(pacificMsSinceToday(12, 0, new Date("2026-08-06T19:00:00Z"))).toFixed(2), "0.02",
    "exactly noon PT floors to one minute, never zero or negative");
  assert.equal(hours(pacificMsSinceToday(12, 0, new Date("2026-08-06T21:30:00Z"))), 2.5);
  assert.equal(hours(pacificMsSinceToday(12, 0, new Date("2026-08-07T02:50:00Z"))), 7.833333333333333);
});

test("a run BEFORE the anchor reaches back to yesterday, not to a negative window", () => {
  // 2026-08-06T15:00Z is 08:00 PT. Noon has not happened yet today, and a
  // negative sinceMs would hit the service's 5-minute floor and silently
  // examine almost nothing — the failure would look like a quiet night.
  const ms = pacificMsSinceToday(12, 0, new Date("2026-08-06T15:00:00Z"));
  assert.equal(hours(ms), 20, "08:00 PT is 20h after noon PT yesterday");
  assert.ok(ms > 0);
});

// Noon-to-evening never straddles the transition. The midday task's prior-day
// 20:00 anchor does, so both shapes are pinned below.

test("DST spring forward: a noon anchor is exact", () => {
  // 2026-03-08. 02:00 PST becomes 03:00 PDT, so the day is 23 hours long — but
  // that hour is gone before noon. 12:00 PDT is 2026-03-08T19:00Z and 19:00 PDT
  // is 2026-03-09T02:00Z: 7 real hours, 7 wall-clock hours.
  const start = new Date("2026-03-08T19:00:00Z");
  const at = new Date("2026-03-09T02:00:00Z");
  assert.equal(hours(at - start), 7, "7 real hours elapsed");
  assert.equal(hours(pacificMsSinceToday(12, 0, at)), 7);
});

test("DST fall back: a noon anchor is exact", () => {
  // 2026-11-01. 02:00 PDT repeats as 01:00 PST, again entirely before noon, so
  // both ends of the window are PST. 12:00 PST is 2026-11-01T20:00Z and 19:00
  // PST is 2026-11-02T03:00Z: 7 real hours, 7 wall-clock hours.
  const start = new Date("2026-11-01T20:00:00Z");
  const at = new Date("2026-11-02T03:00:00Z");
  assert.equal(hours(at - start), 7, "7 real hours elapsed");
  assert.equal(hours(pacificMsSinceToday(12, 0, at)), 7);
});

test("DST spring forward: the prior-20:00 midday window loses the skipped hour", () => {
  // Saturday 20:00 PST = 04:00Z; Sunday noon PDT = 19:00Z.
  const at = new Date("2026-03-08T19:00:00Z");
  assert.equal(hours(pacificMsSinceToday(20, 0, at)), 15);
});

test("DST fall back: the prior-20:00 midday window includes the repeated hour", () => {
  // Saturday 20:00 PDT = 03:00Z; Sunday noon PST = 20:00Z.
  const at = new Date("2026-11-01T20:00:00Z");
  assert.equal(hours(pacificMsSinceToday(20, 0, at)), 17);
});

// ── registration and arming ────────────────────────────────────────────────

test("the evening half lands dark, on its own switch", () => {
  const prior = process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED;
  delete process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED;
  try {
    assert.equal(task().writesArmed(), false);
    process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED = "true";
    assert.equal(task().writesArmed(), true);
  } finally {
    if (prior === undefined) delete process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED;
    else process.env.NIGHTLY_CALL_LOG_HYGIENE_ENABLED = prior;
  }
});

test("it runs before call-recording-index, which reads what it corrects", () => {
  const keys = createNightlyHygieneRuntime({}).TASKS.map((t) => t.key);
  assert.ok(keys.indexOf("call-log-hygiene-evening") >= 0, "must be registered");
  assert.ok(
    keys.indexOf("call-log-hygiene-evening") < keys.indexOf("call-recording-index"),
    "hygiene fixes the day's calls before the recording index reads them",
  );
});

// ── apply(): the window it hands over ──────────────────────────────────────

test("apply passes ONE window end for every domain", async () => {
  // Left unset, the service derives `now` inside its per-domain body, so domain
  // N's window starts N domains' worth of runtime later than domain 0's. With a
  // wall-clock anchored sinceMs there is none of the five minutes of slack the
  // 65-minute default carried against an hourly cadence, so that drift is a
  // gap no later pass recovers.
  const seen = [];
  await task().apply(
    [
      { domain: "TAG", sinceMs: 8 * 3600000, inbound: 3, outbound: 10 },
      { domain: "WYNN", sinceMs: 8 * 3600000, inbound: 1, outbound: 900 },
    ],
    { callLogHygieneImpl: async (a) => { seen.push(a); return { totals: {} }; } },
  );
  assert.equal(seen.length, 1, "the service fans out over domains itself — one call");
  assert.ok(seen[0].now instanceof Date, "an explicit window end must be supplied");
  assert.equal(seen[0].sinceMs, 8 * 3600000);
  assert.deepEqual(seen[0].domains, ["TAG", "WYNN"]);
  assert.equal(seen[0].nativeSweepEnabled, true, "the native sweep is the half that repopulates ex");
  assert.equal(seen[0].scorePendingCalls, false, "night hygiene does not transcribe or score calls");
  assert.equal(seen[0].archiveRecordings, false, "night hygiene does not download or archive audio");
});

test("apply sums ledgerSynced itself — the service never rolls it up", async () => {
  // totals has no ledgerSynced key. The per-domain summaries carry it and the
  // fan-out loop never accumulates it, which is why Phase A's summarizer has
  // always printed ledgerSynced: 0 even on a pass that synced every row.
  const applied = await task().apply(
    [{ domain: "TAG", sinceMs: 3600000, inbound: 1, outbound: 1 }],
    {
      callLogHygieneImpl: async () => ({
        totals: { mirrored: 4, nativeInserted: 6, scoringCompleted: 2, archiveQueued: 3 },
        domains: [
          { domain: "TAG", ok: true, result: { counts: { ledgerSynced: 11 } } },
          { domain: "WYNN", ok: true, result: { counts: { ledgerSynced: 9 } } },
        ],
      }),
    },
  );
  assert.equal(applied.ledgerSynced, 20, "summed from the per-domain summaries");
  assert.equal(applied.written, 10, "mirrored + nativeInserted");
  assert.equal(applied.scored, 2);
  assert.equal(applied.archived, 3);
  assert.equal(applied.failed, 0);
});

test("a domain the service reports as failed is counted, not averaged away", async () => {
  const applied = await task().apply(
    [{ domain: "TAG", sinceMs: 3600000, inbound: 1, outbound: 1 }],
    {
      callLogHygieneImpl: async () => ({
        totals: { mirrored: 1, nativeErrors: 2, scoringFailed: 1 },
        domains: [
          { domain: "TAG", ok: true, result: { counts: { ledgerSynced: 1 } } },
          { domain: "WYNN", ok: false, error: "Logics timeout" },
        ],
      }),
    },
  );
  assert.equal(applied.failed, 4, "2 native + 1 scoring + 1 whole domain");
  assert.match(applied.errors.join(" "), /WYNN: Logics timeout/);
});

test("a throw is the whole half-day, and says so", async () => {
  const applied = await task().apply(
    [{ domain: "TAG", sinceMs: 3600000, inbound: 5, outbound: 5 }],
    { callLogHygieneImpl: async () => { throw new Error("RC 429 rate limited"); } },
  );
  assert.equal(applied.written, 0);
  assert.equal(applied.failed, 1);
  assert.match(applied.errors[0], /hygiene pass failed: RC 429/);
});

// ── unknown vs zero ────────────────────────────────────────────────────────

test("a domain whose window we could not COUNT is a failure, not an empty domain", async () => {
  const seen = [];
  const applied = await task().apply(
    [
      { domain: "TAG", sinceMs: 3600000, inbound: null, outbound: null, error: "connection lost" },
      { domain: "WYNN", sinceMs: 3600000, inbound: 2, outbound: 4 },
    ],
    { callLogHygieneImpl: async (a) => { seen.push(a); return { totals: {} }; } },
  );
  assert.deepEqual(seen[0].domains, ["WYNN"], "an uncounted domain is not handed to the service");
  assert.equal(applied.failed, 1);
  assert.match(applied.errors[0], /TAG: NOT EXAMINED — connection lost/);
});

test("if NO domain could be counted, the service is never called at all", async () => {
  let called = 0;
  const applied = await task().apply(
    [{ domain: "TAG", sinceMs: 3600000, inbound: null, error: "conn lost" }],
    { callLogHygieneImpl: async () => { called += 1; return { totals: {} }; } },
  );
  assert.equal(called, 0);
  assert.equal(applied.failed, 1);
});

test("describe distinguishes could-not-count from a quiet afternoon", () => {
  const allDead = task().describe([
    { domain: "TAG", sinceMs: 3600000, windowStart: "2026-08-06T19:00:00.000Z", inbound: null, error: "conn lost" },
  ]);
  assert.match(allDead, /COULD NOT COUNT THE CALL WINDOW/);
  assert.match(allDead, /conn lost/);

  const partial = task().describe([
    { domain: "TAG", sinceMs: 28800000, windowStart: "2026-08-06T19:00:00.000Z", inbound: null, error: "conn lost" },
    { domain: "WYNN", sinceMs: 28800000, windowStart: "2026-08-06T19:00:00.000Z", inbound: 2, outbound: 40 },
  ]);
  assert.match(partial, /TAG NOT COUNTED/, "one failure must not hide inside the others' totals");
  assert.match(partial, /WYNN 2in\/40out/);
});

test("describe reports the window it actually asked for", () => {
  const summary = task().describe([
    { domain: "TAG", sinceMs: 28800000, windowStart: "2026-08-06T19:00:00.000Z", inbound: 3, outbound: 47 },
  ]);
  assert.match(summary, /8\.0h since 19:00Z/);
  assert.match(summary, /50 call\(s\)/);
});

// ── the preview clamp ──────────────────────────────────────────────────────

test("the preview clamp is reported — a wider window is not wider coverage", () => {
  // callLogRepository clamps the preview query to 500 rows, newest-first, and
  // that clamp is not raisable from the task. On a busy afternoon the rows it
  // drops are the OLDEST in the window — the ones nearest the midday seam —
  // and nothing in the service's own output says so. Measured WYNN outbound
  // afternoons: 1,015 rows/day average, 1,521 max.
  const summary = task().describe([
    { domain: "WYNN", sinceMs: 28800000, windowStart: "2026-08-06T19:00:00.000Z", inbound: 9, outbound: 1015 },
    { domain: "TAG", sinceMs: 28800000, windowStart: "2026-08-06T19:00:00.000Z", inbound: 4, outbound: 12 },
  ]);
  assert.match(summary, /PREVIEW CAPPED at 500\/direction for WYNN/);
  assert.doesNotMatch(summary, /for WYNN, TAG/, "TAG is under the clamp and must not be named");
});

test("the unpreviewed remainder is counted in apply(), not just described", async () => {
  const applied = await task().apply(
    [{ domain: "WYNN", sinceMs: 28800000, inbound: 9, outbound: 1015 }],
    { callLogHygieneImpl: async () => ({ totals: {} }) },
  );
  assert.deepEqual(applied.truncatedDomains, ["WYNN/outbound 515 unpreviewed"]);
});

// ── reachability ───────────────────────────────────────────────────────────

test("a quiet window plans 0 and never applies; a busy one is reachable", () => {
  assert.equal(typeof task().count, "function");
  assert.equal(task().count([{ inbound: 0, outbound: 0 }]), 0);
  assert.equal(task().count([{ inbound: 3, outbound: 47 }, { inbound: 1, outbound: 9 }]), 60);
  // A domain that could not be counted must not inflate the plan.
  assert.equal(task().count([{ inbound: null, outbound: null }]), 0);
});
