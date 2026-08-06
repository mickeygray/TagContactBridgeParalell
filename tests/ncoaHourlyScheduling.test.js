"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveHourlyNcoaSlot } = require("../apps/control-plane/src/server");

test("NCOA gets one dedicated slot per UTC hour", () => {
  const first = resolveHourlyNcoaSlot(null, "2026-08-06T15:17:00.000Z");
  assert.deepEqual(first, { hourKey: "2026-08-06T15", due: true });
  assert.equal(resolveHourlyNcoaSlot(first.hourKey, "2026-08-06T15:59:59.999Z").due, false);
  assert.deepEqual(
    resolveHourlyNcoaSlot(first.hourKey, "2026-08-06T16:00:00.000Z"),
    { hourKey: "2026-08-06T16", due: true },
  );
});

test("NCOA hourly slot rejects an invalid clock instead of spinning", () => {
  assert.throws(() => resolveHourlyNcoaSlot(null, "not-a-date"), /valid date/);
});
