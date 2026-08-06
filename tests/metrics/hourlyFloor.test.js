"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sweeper = require("../../packages/shared-services/src/hourlySweeperService");

/**
 * THE FLOOR SERVICES.
 *
 * Four jobs the business cannot go without: DNC rechecking, the monthly filler-pool
 * rebuild, the rolling aged-pool advance, and the CallRail response-call feeder.
 *
 * They were consumed inside `if (scheduledPhase) {` in runHourlySweep while
 * server.js hardcodes `const runScheduledPhase = false` — so on this branch the
 * caller passes `dncRecheckEnabled: true` and nothing ever reads it. Deploying that
 * stops DNC rechecking outright, which this codebase has already paid for once
 * (see the DNC-bleed history).
 *
 * These tests pin the fix: the floor runs on its own, independent of Phase A, and
 * one failure cannot take the other three down with it.
 */

/** Records what was called, and can be told to fail. */
function fakeImpls(over = {}) {
  const calls = [];
  const track = (name, result) => async (...args) => {
    calls.push({ name, args });
    if (typeof result === "function") return result(...args);
    return result;
  };
  return {
    calls,
    runDncRecheckSweepIfEnabled: track("dnc", { checked: 12 }),
    runMonthlyFillerPoolRefreshIfDue: track("filler", { skipped: true, reason: "not-the-1st" }),
    runAgedRollingRefreshIfDue: track("aged", { promoted: 3 }),
    syncCallrailDailyStats: track("callrail", { days: 2 }),
    ...over,
  };
}

const ALL_ON = {
  dncRecheckEnabled: true,
  fillerPoolRefreshEnabled: true,
  agedRollingRefreshEnabled: true,
};

test("runFloorServices is exported — the floor is reachable without Phase A", () => {
  assert.equal(typeof sweeper.runFloorServices, "function");
});

test("all four floor services run when their flags are on", async () => {
  const impls = fakeImpls();
  process.env.CALLRAIL_STAT_SYNC_ENABLED = "true";
  try {
    const out = await sweeper.runFloorServices({ ...ALL_ON, impls });
    assert.deepEqual(
      Object.keys(out).sort(),
      ["agedRollingRefresh", "callrailStatSync", "dncRecheck", "fillerPoolRefresh"],
    );
    assert.deepEqual(impls.calls.map((c) => c.name).sort(), ["aged", "callrail", "dnc", "filler"]);
    assert.deepEqual(out.dncRecheck, { checked: 12 });
    assert.deepEqual(out.agedRollingRefresh, { promoted: 3 });
  } finally {
    delete process.env.CALLRAIL_STAT_SYNC_ENABLED;
  }
});

test("one failing service does not cost the other three", async () => {
  // Each entry carries its own .catch() for exactly this. A floor that fails
  // all-or-nothing is worse than the bug it replaced.
  const impls = fakeImpls({
    runDncRecheckSweepIfEnabled: async () => { throw new Error("realvalidation timeout"); },
  });
  const out = await sweeper.runFloorServices({ ...ALL_ON, impls });
  assert.match(String(out.dncRecheck.error), /realvalidation timeout/);
  assert.deepEqual(out.agedRollingRefresh, { promoted: 3 });
  assert.deepEqual(out.fillerPoolRefresh, { skipped: true, reason: "not-the-1st" });
});

test("a flag that is off skips the service without calling it", async () => {
  const impls = fakeImpls();
  const out = await sweeper.runFloorServices({
    ...ALL_ON, dncRecheckEnabled: false, impls,
  });
  assert.equal(out.dncRecheck.skipped, true);
  assert.equal(impls.calls.some((c) => c.name === "dnc"), false);
});

test("callrail stat sync stays env-gated, not caller-gated", async () => {
  // Deliberate: the env gate lives with the service so a caller's phase split
  // cannot silently starve the response-call feeder.
  const impls = fakeImpls();
  delete process.env.CALLRAIL_STAT_SYNC_ENABLED;
  const out = await sweeper.runFloorServices({ ...ALL_ON, impls });
  assert.equal(out.callrailStatSync.skipped, true);
  assert.equal(impls.calls.some((c) => c.name === "callrail"), false);
});

test("callrail sync asks for yesterday and today, as Pacific day keys", async () => {
  const seen = [];
  const impls = fakeImpls({
    syncCallrailDailyStats: async (args) => { seen.push(args); return { days: 2 }; },
  });
  process.env.CALLRAIL_STAT_SYNC_ENABLED = "true";
  try {
    await sweeper.runFloorServices({ ...ALL_ON, impls });
    assert.equal(seen.length, 1);
    assert.match(seen[0].from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(seen[0].to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(seen[0].from <= seen[0].to, "from must not be after to");
  } finally {
    delete process.env.CALLRAIL_STAT_SYNC_ENABLED;
  }
});

test("the sweep runs the floor even with Phase A off — the whole point", async () => {
  // scheduledPhase:false is what server.js hardcodes today. Phase A stays null;
  // the floor must still be there.
  const impls = fakeImpls();
  const summary = await sweeper.runHourlySweep({
    workerName: "test-floor",
    lane: "hourly",
    scheduledPhase: false,
    handlerKeys: [],
    batchCap: 0,
    floorImpls: impls,
    ...ALL_ON,
  });
  assert.equal(summary.phaseA, null, "Phase A must stay retired");
  assert.ok(summary.floor, "the floor must run without Phase A");
  assert.deepEqual(
    Object.keys(summary.floor).sort(),
    ["agedRollingRefresh", "callrailStatSync", "dncRecheck", "fillerPoolRefresh"],
  );
  assert.equal(impls.calls.some((c) => c.name === "dnc"), true);
});

test("the floor survives the exact call the control plane makes", async () => {
  // server.js:690 hardcodes runScheduledPhase=false and :720 scheduledPhaseLite=true,
  // which sets sessionReconcile/paymentReconcile/paymentFieldsSync/metricsRefresh/
  // callLogHygiene to !scheduledPhaseLite === false, while :810-822 passes the three
  // floor flags true. That combination is what silently killed the floor. Pin it.
  const impls = fakeImpls();
  process.env.CALLRAIL_STAT_SYNC_ENABLED = "true";
  try {
    const summary = await sweeper.runHourlySweep({
      workerName: "control-plane-hourly-sweep",
      lane: "hourly",
      scheduledPhase: false,
      batchCap: 0,
      handlerKeys: [],
      sessionReconcileEnabled: false,
      paymentReconcileEnabled: false,
      paymentFieldsSyncEnabled: false,
      metricsRefreshEnabled: false,
      callLogHygieneEnabled: false,
      dncRecheckEnabled: true,
      fillerPoolRefreshEnabled: true,
      agedRollingRefreshEnabled: true,
      resolutionEmailsEnabled: false,
      floorImpls: impls,
    });
    assert.equal(summary.phaseA, null);
    // All four, under the real flag shape.
    assert.deepEqual(impls.calls.map((c) => c.name).sort(), ["aged", "callrail", "dnc", "filler"]);
    assert.equal(summary.floor.dncRecheck.checked, 12);
  } finally {
    delete process.env.CALLRAIL_STAT_SYNC_ENABLED;
  }
});

test("the floor still runs when Phase A DOES run — no double-call, no gap", async () => {
  // The other direction: if anyone re-enables scheduledPhase (or nightlyClose calls
  // with scheduledPhase:true), the floor must run exactly once, not twice, and Phase A
  // must no longer carry its own copies of the four.
  const impls = fakeImpls();
  const summary = await sweeper.runHourlySweep({
    workerName: "nightly-close-final",
    lane: "nightly",
    scheduledPhase: true,
    batchCap: 0,
    handlerKeys: [],
    domains: [],
    sessionReconcileEnabled: false,
    paymentReconcileEnabled: false,
    paymentFieldsSyncEnabled: false,
    metricsRefreshEnabled: false,
    callLogHygieneEnabled: false,
    cxCallActivityBackfillEnabled: false,
    cxTerminalRectificationEnabled: false,
    cxRecordingHourlyEnabled: false,
    leadCadenceEnforcementEnabled: false,
    staleCadenceSweepEnabled: false,
    staleNcoaSweepEnabled: false,
    calllogBridgeEnabled: false,
    resolutionEmailsEnabled: false,
    dncRecheckEnabled: true,
    fillerPoolRefreshEnabled: true,
    agedRollingRefreshEnabled: true,
    floorImpls: impls,
  });
  assert.ok(summary.phaseA, "Phase A ran");
  // Exactly once each — the moved entries are gone from Phase A.
  assert.equal(impls.calls.filter((c) => c.name === "dnc").length, 1);
  assert.equal(impls.calls.filter((c) => c.name === "aged").length, 1);
  assert.equal(impls.calls.filter((c) => c.name === "filler").length, 1);
  // And Phase A no longer reports them.
  assert.equal("dncRecheck" in summary.phaseA, false);
  assert.equal("fillerPoolRefresh" in summary.phaseA, false);
  assert.equal("agedRollingRefresh" in summary.phaseA, false);
  assert.equal("callrailStatSync" in summary.phaseA, false);
});

// ── E9: THE HOURLY SWEEP NO LONGER OWNS NCOA ───────────────────────────────
//
// NCOA had TWO hourly triggers: server.js's own hour slot, and an ungated call
// inside the sweep's scheduled phase. Both are retired in favour of the nightly
// mailbox visit. This is the guard against a re-armed Phase A quietly becoming
// a second owner of a job that already has one.

test("the hourly sweep does not run the NCOA mailbox — the nightly task owns it", () => {
  const source = require("node:fs").readFileSync(
    require.resolve("../../packages/shared-services/src/hourlySweeperService"),
    "utf8",
  );
  // The require is gone, so the sweeper cannot call it even by accident.
  assert.doesNotMatch(
    source.replace(/\/\/[^\n]*/g, ""),
    /runNcoaMailboxIngestIfDue/,
    "the sweeper must not import or call the NCOA mailbox ingest",
  );
});

test("the NCOA service itself is untouched — folded, not deleted", () => {
  // The fold moved the TRIGGER. The service still exists and still runs from
  // scripts/run-ncoa-mailbox-ingest.js, which is how a missed day is repaired.
  const svc = require("../../packages/shared-services/src/ncoaMailboxIngestService");
  assert.equal(typeof svc.runNcoaMailboxIngestIfDue, "function");
});
