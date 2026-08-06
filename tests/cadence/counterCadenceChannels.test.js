"use strict";

// M4 — SPLITTING THE CADENCE CHAIN ACROSS PASSES.
//
// Mickey 2026-08-06: "all the texts and emails at 8 and all the rvms at noon
// kinda thing." A caller must be able to ask for a subset of the chain without
// the others firing, and `channels: null` must remain today's behaviour exactly.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateCounterCadenceDueItems,
} = require("../../packages/shared-services/src/counterCadenceService");

// A lead old enough for the daily push on all three chains, with every channel
// contactable and nothing blocked or deferred.
const lead = (over = {}) => ({
  domain: "TAG",
  caseId: 4242,
  active: true,
  cadenceMode: "legacy-time-count",
  primaryPhone: "5625551212",
  email: "someone@example.com",
  createdAt: new Date("2026-07-01T16:00:00Z"),
  // The real accessor paths: getCounterCadenceCounters reads `cadenceCounters`
  // and getCounterCadenceLastTouched reads `lastTouched` — NOT the nested
  // counterCadence subdocument, which holds only the locks, defer stamps and
  // the daily batch keys.
  cadenceCounters: { sms: 2, email: 1, rvm: 0 },
  lastTouched: {},
  counterCadence: { lastDailyBatchKey: {}, locks: {}, ...(over.counterCadence || {}) },
  ...over,
});

// Inside the default daily window (Mon-Fri 09:00-11:59 PT). 2026-08-06 is a
// Thursday; 17:30Z is 10:30 PT.
const IN_WINDOW = new Date("2026-08-06T17:30:00Z");
const channelsOf = (items) => [...new Set(items.map((i) => i.channel))].sort();

test("channels null is today's behaviour — the whole chain is considered", () => {
  const items = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW });
  const withNull = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: null });
  assert.deepEqual(channelsOf(withNull), channelsOf(items),
    "passing channels:null explicitly must change nothing");
  assert.ok(items.length > 0, "the fixture must actually be due for something");
});

test("a morning pass asking for sms+email yields no rvm", () => {
  const items = evaluateCounterCadenceDueItems(lead(), {
    now: IN_WINDOW, channels: ["sms", "email"],
  });
  assert.ok(items.length > 0, "sms/email must still be selected");
  assert.equal(items.some((i) => i.channel === "rvm"), false, "no rvm may ride the morning pass");
  for (const item of items) assert.ok(["sms", "email"].includes(item.channel));
});

test("a midday pass asking for rvm yields ONLY rvm", () => {
  const items = evaluateCounterCadenceDueItems(lead(), {
    now: IN_WINDOW, channels: ["rvm"],
  });
  assert.deepEqual(channelsOf(items), ["rvm"]);
});

test("the two passes together cover exactly what one unfiltered pass would", () => {
  // The split must not lose an item or invent one.
  const all = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW });
  const morning = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: ["sms", "email"] });
  const midday = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: ["rvm"] });
  const key = (i) => `${i.channel}-${i.templateIndex}-${i.reason}`;
  assert.deepEqual(
    [...morning, ...midday].map(key).sort(),
    all.map(key).sort(),
  );
});

test("the channel filter is case- and shape-tolerant", () => {
  const a = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: ["RVM"] });
  const b = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: "rvm" });
  assert.deepEqual(channelsOf(a), ["rvm"]);
  assert.deepEqual(channelsOf(b), ["rvm"], "a bare string is accepted");
});

test("an EMPTY channel list means unfiltered, not silence", () => {
  // A caller that computed its channel list and got [] must not be read as
  // "send nothing to everyone" — that shape is almost always a bug upstream,
  // and silently sending the whole chain is the safer of two bad readings only
  // because it matches the documented `null` default. Pinned so the choice is
  // explicit rather than accidental.
  const items = evaluateCounterCadenceDueItems(lead(), { now: IN_WINDOW, channels: [] });
  assert.ok(items.length > 0);
});

// ── the age-relative SMS-2, which must survive a daily-off pass (M5) ───────

test("age-relative SMS-2 fires with the daily push off", () => {
  // It is evaluated BEFORE the daily gate, which is what lets the real-time
  // gateway worker keep first-touch follow-up while the batch passes own the
  // daily chain.
  const justOne = lead({
    cadenceCounters: { sms: 1, email: 1, rvm: 0 },
    lastTouched: { sms: new Date("2026-08-06T12:00:00Z") },
    createdAt: new Date("2026-08-06T12:00:00Z"),
  });
  const items = evaluateCounterCadenceDueItems(justOne, {
    now: IN_WINDOW, includeDaily: false,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].channel, "sms");
  assert.equal(items[0].templateIndex, 2);
  assert.equal(items[0].reason, "text-2-age-relative");
});

test("a channel filter that excludes sms also silences the age-relative push", () => {
  // Otherwise a midday rvm-only pass would send an sms.
  const justOne = lead({
    cadenceCounters: { sms: 1, email: 1, rvm: 0 },
    lastTouched: { sms: new Date("2026-08-06T12:00:00Z") },
    createdAt: new Date("2026-08-06T12:00:00Z"),
  });
  const items = evaluateCounterCadenceDueItems(justOne, {
    now: IN_WINDOW, includeDaily: false, channels: ["rvm"],
  });
  assert.deepEqual(items, [], "an rvm-only pass must not text anybody");
});

// ── the window, which is why a 08:00 pass needs forceDaily ─────────────────

test("OUTSIDE the daily window nothing daily is due — this is why 08:00 needs forceDaily", () => {
  // The window is Mon-Fri 09:00-11:59 PT (COUNTER_CADENCE_DAILY_HOUR default 9,
  // window 180 min). A morning pass at 08:00 PT is BEFORE it, so without
  // forceDaily it would select nothing every day and report a confident zero.
  const eightAm = new Date("2026-08-06T15:00:00Z"); // 08:00 PT
  const items = evaluateCounterCadenceDueItems(lead(), { now: eightAm, channels: ["sms", "email"] });
  assert.deepEqual(items, [], "08:00 PT is outside the daily window");

  const forced = evaluateCounterCadenceDueItems(lead(), {
    now: eightAm, channels: ["sms", "email"], forceDaily: true,
  });
  assert.ok(forced.length > 0, "forceDaily is what makes an 08:00 pass send at all");
  assert.equal(forced.some((i) => i.channel === "rvm"), false);
});

test("forceDaily bypasses the WINDOW only, never the once-a-day-per-channel key", () => {
  // The work order said forceDaily "permits the second same-day batch past
  // lastDailyBatchKey". It does not — it only bypasses isWeekdayBatchTime.
  // dailyAlreadyTouched is a separate, unconditional guard, which is what stops
  // a second pass re-sending the same channel on the same day.
  const alreadySentToday = lead({
    counterCadence: {
      lastDailyBatchKey: { rvm: "2026-08-06", sms: "2026-08-06", email: "2026-08-06" },
      locks: {},
    },
  });
  const items = evaluateCounterCadenceDueItems(alreadySentToday, {
    now: IN_WINDOW, forceDaily: true,
  });
  assert.deepEqual(items, [],
    "forceDaily must NOT re-send a channel already batched today");
});

test("a midday rvm pass is the day's FIRST rvm batch, not a second one", () => {
  // Which is why the split works at all: the morning pass stamps
  // lastDailyBatchKey for sms and email only, leaving rvm untouched and due.
  const morningAlreadyRan = lead({
    counterCadence: {
      lastDailyBatchKey: { sms: "2026-08-06", email: "2026-08-06" },
      locks: {},
    },
  });
  const items = evaluateCounterCadenceDueItems(morningAlreadyRan, {
    now: IN_WINDOW, channels: ["rvm"], forceDaily: true,
  });
  assert.deepEqual(channelsOf(items), ["rvm"]);
});

// ── the sweep must actually honour what it is handed ──────────────────────

test("runCounterCadenceSweep no longer overrides the caller's flags", () => {
  // It used to hardcode includeAgeRelative:true and includeDaily:true inside
  // the function, so a caller passing false compiled, read correctly, and
  // changed nothing. That is the worst shape a flag can have.
  const source = require("node:fs")
    .readFileSync(
      require.resolve("../../packages/shared-services/src/counterCadenceService"), "utf8",
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const sweep = source.slice(source.indexOf("async function runCounterCadenceSweep"));
  const call = sweep.slice(sweep.indexOf("selectCounterCadenceDueItems({"));
  assert.doesNotMatch(call.slice(0, 400), /includeAgeRelative:\s*true/,
    "the sweep must pass the caller's value through, not a literal");
  assert.doesNotMatch(call.slice(0, 400), /includeDaily:\s*true/);
  assert.match(call.slice(0, 400), /channels,/);
});
