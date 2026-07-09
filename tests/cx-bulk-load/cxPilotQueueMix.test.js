"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPilotInterleavedFamilies,
  buildPilotMixUpsertFilter,
  computePilotMixTargets,
  normalizePilotMixFamily,
  parsePilotMixSpec,
} = require("../../scripts/cx-pilot-queue");

test("pilot mix maps Mickey colors to queue source families", () => {
  assert.equal(normalizePilotMixFamily("green"), "fresh-day1");
  assert.equal(normalizePilotMixFamily("blue"), "fresh-day2to10");
  assert.equal(normalizePilotMixFamily("yellow"), "fresh-day16to30");
  assert.equal(normalizePilotMixFamily("red"), "aged");
  assert.equal(normalizePilotMixFamily("fresh-day1"), "fresh-day1");
});

test("pilot mix target counts split 300 as 180/90/15/15", () => {
  assert.deepEqual(computePilotMixTargets(300, "60/30/5/5"), {
    "fresh-day1": 180,
    "fresh-day2to10": 90,
    "fresh-day16to30": 15,
    aged: 15,
  });
});

test("pilot mix accepts named color specs", () => {
  assert.deepEqual(parsePilotMixSpec("green=60 blue=30 yellow=5 red=5"), [60, 30, 5, 5]);
});

test("pilot mix interleaves ranks while preserving final counts", () => {
  const targets = computePilotMixTargets(300, "60/30/5/5");
  const order = buildPilotInterleavedFamilies(targets);
  const counts = order.reduce((acc, family) => {
    acc[family] = (acc[family] || 0) + 1;
    return acc;
  }, {});

  assert.equal(order.length, 300);
  assert.deepEqual(counts, targets);
  assert.ok(order.slice(0, 20).includes("fresh-day2to10"), "blue appears in the first refill page");
  assert.ok(order.slice(0, 40).includes("fresh-day16to30"), "yellow appears early instead of after all green/blue");
  assert.ok(order.slice(0, 40).includes("aged"), "red appears early instead of after all green/blue/yellow");
});

test("pilot mix upsert filter skips any active row for the same case at arm time", () => {
  const filter = buildPilotMixUpsertFilter("wynn", 12345);

  assert.deepEqual(filter, {
    domain: "WYNN",
    caseId: 12345,
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  });
  assert.equal(Object.hasOwn(filter, "metadata.actionKey"), false);
});
