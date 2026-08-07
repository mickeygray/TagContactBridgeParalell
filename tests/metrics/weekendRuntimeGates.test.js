"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  createReportScheduleRuntime,
  isPacificBusinessDay: reportBusinessDay,
} = require("../../apps/control-plane/src/services/reportScheduleRuntime");
const {
  normalizeActiveWeekdays: normalizeCloseWeekdays,
} = require("../../apps/control-plane/src/services/nightlyCloseRuntime");
const {
  normalizeActiveWeekdays: normalizeLexisWeekdays,
} = require("../../apps/control-plane/src/services/lexisNightlyService");

test("report scheduler recognizes and skips Pacific weekends", async () => {
  assert.equal(reportBusinessDay(new Date("2026-08-02T16:00:00.000Z")), false);
  assert.equal(reportBusinessDay(new Date("2026-08-03T16:00:00.000Z")), true);
  const runtime = createReportScheduleRuntime({ config: { enabled: true, managedByNightly: false } });
  assert.deepEqual(
    await runtime.poll({ now: new Date("2026-08-02T16:00:00.000Z") }),
    { skipped: "pacific-weekend" },
  );
});

test("nightly ownership disables the report timer but keeps forced execution available", async () => {
  const now = new Date("2026-08-04T03:00:00.000Z");
  const seen = [];
  const runtime = createReportScheduleRuntime({
    config: { enabled: true, managedByNightly: true },
    runtime: {
      dueDefinitions: async (value) => {
        seen.push(["due", value]);
        return [{ name: "nightly" }];
      },
      runDefinition: async (_definition, options) => {
        seen.push(["run", options.now]);
        return {
          range: { from: "2026-08-03", to: "2026-08-03" },
          delivered: true,
          sections: 1,
          errors: [],
          durationMs: 1,
        };
      },
    },
  });
  const state = runtime.getState();
  assert.equal(state.configuredEnabled, true);
  assert.equal(state.enabled, false);
  assert.equal(state.owner, "nightly-hygiene");
  assert.deepEqual(await runtime.poll(), { skipped: "disabled" });
  const result = await runtime.poll({ force: true, now });
  assert.equal(result.ran, 1);
  assert.deepEqual(seen.map(([step, value]) => [step, value.toISOString()]), [
    ["due", now.toISOString()],
    ["run", now.toISOString()],
  ]);
});

test("the report scheduler remains standalone when nightly ownership is off", () => {
  const state = createReportScheduleRuntime({
    config: { enabled: true, managedByNightly: false },
  }).getState();
  assert.equal(state.configuredEnabled, true);
  assert.equal(state.enabled, true);
  assert.equal(state.owner, "standalone");
});

test("nightly close and Lexis schedules cannot arm Saturday or Sunday", () => {
  assert.deepEqual(normalizeCloseWeekdays([0, 1, 5, 6]), [1, 5]);
  assert.deepEqual(normalizeLexisWeekdays([0, 2, 6]), [2]);
  assert.deepEqual(normalizeCloseWeekdays([0, 6]), [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeLexisWeekdays([0, 6]), [1, 2, 3, 4, 5]);
});

test("the manual forceDaily route cannot bypass the Pacific weekend gate", () => {
  const source = fs.readFileSync(
    require.resolve("../../apps/outbound-gateway/src/server"),
    "utf8",
  );
  const route = source.slice(source.indexOf('app.post("/api/outbound/counter-cadence/run"'));
  assert.match(route, /forceDaily && !dryRun && !isPacificBusinessDay\(now\)/);
  assert.match(route, /reason: "pacific-weekend"/);
});
