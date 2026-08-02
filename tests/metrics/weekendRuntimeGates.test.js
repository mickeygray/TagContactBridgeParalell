"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
  const runtime = createReportScheduleRuntime({ config: { enabled: true } });
  assert.deepEqual(
    await runtime.poll({ now: new Date("2026-08-02T16:00:00.000Z") }),
    { skipped: "pacific-weekend" },
  );
});

test("nightly close and Lexis schedules cannot arm Saturday or Sunday", () => {
  assert.deepEqual(normalizeCloseWeekdays([0, 1, 5, 6]), [1, 5]);
  assert.deepEqual(normalizeLexisWeekdays([0, 2, 6]), [2]);
  assert.deepEqual(normalizeCloseWeekdays([0, 6]), [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeLexisWeekdays([0, 6]), [1, 2, 3, 4, 5]);
});
