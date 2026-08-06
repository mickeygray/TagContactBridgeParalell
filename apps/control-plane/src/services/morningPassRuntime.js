"use strict";

// THE MORNING PASS — set the day up, then send the sms/email half of cadence.
//
// Mickey 2026-08-06: "1) set up the morning and run lead cadence for the day
// ... all the texts and emails at 8 and all the rvms at noon kinda thing."
//
// Everything here lands DARK. MORNING_PASS_ENABLED arms the runtime; each task
// then has its own flag, so arming the pass and arming a chore are two
// decisions.
//
// ── THE FLOOR SERVICES ARE THE DANGEROUS PART ──────────────────────────────
//
// The four of them — callrailStatSync, dncRecheck, fillerPoolRefresh,
// agedRollingRefresh — currently run on EVERY hourly tick, hoisted deliberately
// outside the dead Phase A gate (hourlySweeperService, "THE FLOOR"). Two are
// live on this box today.
//
// The work order said to register them here AND delete that hoist in the same
// commit, on the two-step-handover rule. That rule exists to stop a job running
// twice — but applied here it would do the opposite and create a GAP: a dark
// runtime never even creates a timer, so between deploy and arming NOTHING
// would run them. callrailStatSync feeds the board's response counts;
// agedRollingRefresh advances the 30/60/90 ladder.
//
// So the handover is deferred to the moment it becomes real: the hoist is
// deleted in the SAME commit that arms this pass, not before. Until then these
// tasks are dark and the hoist is the only owner, which is exactly one owner.
// The runbook records it.

const { createPassRuntime } = require("./passRuntimeFactory");

const flag = (name) => String(process.env[name] || "false").toLowerCase() === "true";

const TASKS = [
  {
    // ONE CALL, NOT FOUR. runFloorServices already owns the four services and
    // their individual env gates. Re-implementing its members here was not
    // possible anyway: two are module-private and callrailStatSync is an inline
    // body with its own day helper, so a copy would be a rewrite — the drift
    // this repo has already paid for twice.
    key: "floor-services",
    label: "Floor services (CallRail stats, DNC recheck, filler pool, aged ladder)",
    writesArmed: () => flag("MORNING_FLOOR_SERVICES_ENABLED"),
    async plan() {
      // Nothing to enumerate cheaply: each service owns its own due-check and
      // none of them can be asked "what would you do" without doing it. One
      // indivisible unit, the spend-sync idiom.
      return [{
        services: ["callrailStatSync", "dncRecheck", "fillerPoolRefresh", "agedRollingRefresh"],
      }];
    },
    count() { return 1; },
    async apply(planned, { logger, floorImpls = null }) {
      const {
        runFloorServices,
      } = require("../../../../packages/shared-services/src/hourlySweeperService");
      const r = await runFloorServices({
        dncRecheckEnabled: true,
        fillerPoolRefreshEnabled: true,
        agedRollingRefreshEnabled: true,
        logger,
        impls: floorImpls,
      });
      const skipped = Object.values(r || {}).filter((v) => v && v.skipped).length;
      const errored = Object.values(r || {}).filter((v) => v && v.error).length;
      return {
        written: Object.values(r || {}).filter((v) => v && !v.skipped && !v.error).length,
        skipped,
        failed: errored,
        services: r,
      };
    },
    describe(planned) {
      return `${(planned[0]?.services || []).join(", ")} — each still gated by its own env flag`;
    },
  },
  {
    // THE MORNING CADENCE HALF: sms and email only.
    //
    // forceDaily is NOT optional here and the reason is easy to miss. The
    // cadence daily window is COUNTER_CADENCE_DAILY_HOUR (default 9) plus
    // COUNTER_CADENCE_DAILY_WINDOW_MINUTES (default 180) — 09:00–11:59 PT. This
    // pass fires at 08:00, BEFORE it. Without forceDaily the sweep would select
    // nothing, every single day, and report a confident `selected: 0`.
    //
    // forceDaily bypasses that WINDOW and nothing else. The once-a-day-per-
    // channel guard (lastDailyBatchKey) is separate and unconditional, so this
    // cannot double-send, and it is also what lets the midday rvm pass be the
    // day's FIRST rvm batch rather than a blocked second one.
    key: "cadence-morning",
    label: "Lead cadence — texts and emails",
    writesArmed: () => flag("MORNING_CADENCE_ENABLED"),
    async plan({ domains }) {
      return [{ domains: [...domains], channels: ["sms", "email"], maxDispatches: morningCadenceCap() }];
    },
    count() { return 1; },
    async apply(planned, { logger, cadenceImpl = null }) {
      const run = cadenceImpl
        || require("../../../../packages/shared-services/src/counterCadenceService").runCounterCadenceSweep;
      const p = planned[0] || {};
      const r = await run({
        domains: p.domains,
        channels: p.channels,
        // The real-time first touch and the age-relative SMS-2 stay with the
        // outbound gateway's 5s worker. This pass owns the DAILY chain only.
        includeAgeRelative: false,
        includeDaily: true,
        forceDaily: true,
        maxDispatches: p.maxDispatches,
        sourceService: "morning-pass",
        logger,
      });
      return {
        written: Number(r?.sent) || 0,
        selected: Number(r?.selected) || 0,
        skipped: Number(r?.skipped) || 0,
        failed: Number(r?.failed) || 0,
      };
    },
    describe(planned) {
      const p = planned[0] || {};
      return `${(p.channels || []).join("+")} to up to ${p.maxDispatches} lead(s)`
        + ` across ${(p.domains || []).join(", ")} — daily chain only, forced past the 09:00 window`;
    },
  },
];

const morningCadenceCap = () => Math.max(1, Number(process.env.MORNING_CADENCE_MAX_DISPATCHES) || 200);

function createMorningPassRuntime({ config = {}, runtime = {} } = {}) {
  return createPassRuntime({
    passKey: "morning",
    label: "Morning pass",
    enabledEnv: "MORNING_PASS_ENABLED",
    // D5's default. 08:00 PT is also exactly the TCPA contact floor, so there is
    // no margin below it — a pass that drifted earlier would defer every sms and
    // rvm item rather than send them.
    defaultHour: 8,
    tasks: TASKS,
    config,
    runtime,
  });
}

module.exports = { TASKS, createMorningPassRuntime };
