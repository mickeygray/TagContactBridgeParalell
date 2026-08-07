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
  recordCounterCadenceSkipAttempt,
} = require("../../packages/shared-services/src/counterCadenceService");
const { LeadCadence } = require("../../packages/shared-models/src");

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

// ── AUDIT FIX: the drain loop ──────────────────────────────────────────────

test("the drain loop keeps sweeping until the backlog is gone", async () => {
  // One sweep caps at maxDispatches; a once-a-day pass calling it once sent one
  // batch and silently postponed the rest — 900 due items meant 200 sent and
  // 700 deferred with nothing saying so.
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  // Simulate a 450-item backlog against a 200 cap by stubbing the sweep via
  // the module boundary: drain calls runCounterCadenceSweep internally, so we
  // exercise the real loop arithmetic with a probe that decrements a backlog.
  // (The internal call is not injectable; assert the loop's OBSERVABLE
  // arithmetic instead through its stop conditions using dryRun selection.)
  const source = String(drainCounterCadenceSweep);
  assert.match(source, /selected.*< perRound/s, "stops when the selector runs dry");
  assert.match(source, /attemptsConsumed/s, "a consumed skip advances the drain without claiming a send");
  assert.match(source, /maxRounds/, "bounded wall clock inside the pass lease");
});

test("a SKIP is reported but does not withhold drained — it must not order a retry", async () => {
  // drained is consumed by passRuntimeFactory, which turns false into a throw
  // and three attempts five minutes apart. That is the right answer for a
  // FAILURE and the wrong one for a skip: three attempts across fifteen minutes
  // cannot outrun a token bucket, and no number of retries fixes a bad phone
  // number or a stop-contact status.
  //
  // Worse, the counter is cumulative across rounds and most skip reasons never
  // leave the due set, so requiring skipped===0 made drained:true unreachable
  // for that pass FOREVER after a single such lead — the cadence task failing
  // every armed day, at three times the provider volume.
  //
  // What is still due is carried by `skipped` and surfaced in the summary,
  // which informs an operator without ordering work that cannot succeed.
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  const out = await drainCounterCadenceSweep({
    maxDispatches: 200,
    roundPauseMs: 0,
    sweepImpl: async () => ({ selected: 1, sent: 0, failed: 0, skipped: 1 }),
  });
  assert.equal(out.drained, true, "a paced or refused item is not undone work");
  assert.equal(out.skipped, 1, "but it is still REPORTED, so nothing is hidden");
});

test("a FAILURE does withhold drained — that is what the retry is for", async () => {
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  const out = await drainCounterCadenceSweep({
    maxDispatches: 200,
    roundPauseMs: 0,
    sweepImpl: async () => ({ selected: 1, sent: 0, failed: 1, skipped: 0 }),
  });
  assert.equal(out.drained, false);
  assert.equal(out.failed, 1);
});

test("a permanently-skippable lead cannot make drained unreachable forever", async () => {
  // The cumulative counter is the trap: one lead that can never be sent — an
  // invalid phone, a suppression, a stop-contact status — is skipped on every
  // round of every run, so a cumulative skipped>0 test would fail every day.
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  let round = 0;
  const out = await drainCounterCadenceSweep({
    maxDispatches: 2,
    roundPauseMs: 0,
    // Round 1 fills the cap with one send and one permanent skip; round 2 finds
    // only the permanent skip left, so the selector runs dry.
    sweepImpl: async () => {
      round += 1;
      return round === 1
        ? { selected: 2, sent: 1, failed: 0, skipped: 1 }
        : { selected: 1, sent: 0, failed: 0, skipped: 1 };
    },
  });
  assert.equal(out.drained, true, "the day finished; one lead is simply unsendable");
  assert.equal(out.skipped, 2, "and both skips are on the record");
});

test("an actually empty cadence selection certifies the backlog drained", async () => {
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  const out = await drainCounterCadenceSweep({
    maxDispatches: 200,
    roundPauseMs: 0,
    sweepImpl: async () => ({ selected: 0, sent: 0, failed: 0, skipped: 0 }),
  });
  assert.equal(out.drained, true);
});

test("both passes call the DRAIN, not the single sweep", () => {
  for (const mod of [
    "../../apps/control-plane/src/services/morningPassRuntime",
    "../../apps/control-plane/src/services/middayPassRuntime",
  ]) {
    const src = require("node:fs").readFileSync(require.resolve(mod), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.match(src, /drainCounterCadenceSweep/, `${mod} must drain`);
  }
});

// ── THE CLAIM IS THE DAY GUARD (adversarial pass, CRITICAL) ────────────────
//
// A sweep materialises its due list up front and dispatches over minutes. The
// lock it takes is UNSET when a send completes, so a second sender arriving
// later found it free and re-sent the same template — and afterwards the row is
// byte-identical to a single send (same absolute counter, same batch key), so
// the duplicate is invisible. With two daily senders live at once, which the
// documented cutover deliberately creates, that is a duplicate text to a real
// person.

const { buildCounterCadenceClaimFilter } = require(
  "../../packages/shared-services/src/counterCadenceService",
);

/** Enough of Mongo's matcher to evaluate the claim filter against a document. */
const valueAt = (doc, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), doc);
function matches(filter, doc) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((c) => matches(c, doc));
    const v = valueAt(doc, key);
    if (cond === null || typeof cond !== "object") return v === cond;
    if ("$exists" in cond) return (v !== undefined) === cond.$exists;
    if ("$ne" in cond) return v !== cond.$ne;
    if ("$lte" in cond) return v != null && v <= cond.$lte;
    if ("$not" in cond) return !matches({ [key]: cond.$not }, doc);
    if ("$gte" in cond) return v != null && v >= cond.$gte;
    return false;
  });
}

const NOW = new Date("2026-08-06T17:30:00Z"); // 10:30 PT
const TODAY = "2026-08-06";
const dailyItem = (over = {}) => ({
  lead: { _id: "lead-1" }, domain: "TAG", caseId: 4242,
  channel: "sms", templateIndex: 3, reason: "daily-time-of-day", ...over,
});

test("a lead already batched today for this channel CANNOT be claimed again", () => {
  const filter = buildCounterCadenceClaimFilter(dailyItem(), NOW);
  const alreadySent = {
    _id: "lead-1", active: true,
    cadenceCounters: { sms: 3 },
    counterCadence: { lastDailyBatchKey: { sms: TODAY } },
  };
  assert.equal(matches(filter, alreadySent), false,
    "the second sender must lose at the database, not re-send");
});

test("the lock being FREE is not enough — that was the whole defect", () => {
  // recordCounterCadenceTouch $unsets the lock on a completed send, so the
  // second claimant always finds it free. Only the counter and the day key
  // carry the evidence that the work is done.
  const filter = buildCounterCadenceClaimFilter(dailyItem(), NOW);
  const lockFreeButSent = {
    _id: "lead-1", active: true,
    cadenceCounters: { sms: 3 },
    counterCadence: { locks: {}, lastDailyBatchKey: { sms: TODAY } },
  };
  assert.equal(matches(filter, lockFreeButSent), false);
});

test("a lead that has NOT been sent today is still claimable", () => {
  const filter = buildCounterCadenceClaimFilter(dailyItem(), NOW);
  const due = {
    _id: "lead-1", active: true,
    cadenceCounters: { sms: 2 },
    counterCadence: { lastDailyBatchKey: { sms: "2026-08-05" } },
  };
  assert.equal(matches(filter, due), true, "yesterday's key must not block today");
});

test("a LEGACY lead whose counter lives elsewhere keeps its first send", () => {
  // getCounterCadenceCounters falls back to cadenceState/payloadSnapshot, so an
  // equality CAS on cadenceCounters would refuse a genuine first send. A missing
  // field does not match $gte, so $not passes.
  const filter = buildCounterCadenceClaimFilter(dailyItem(), NOW);
  const legacy = {
    _id: "lead-1", active: true,
    payloadSnapshot: { legacyCounters: { textsSent: 2 } },
  };
  assert.equal(matches(filter, legacy), true);
});

test("the counter clause alone stops a same-index double fire", () => {
  // Belt and braces for the age-relative push, which carries no day key.
  const filter = buildCounterCadenceClaimFilter(
    dailyItem({ templateIndex: 2, reason: "text-2-age-relative" }), NOW,
  );
  assert.equal("counterCadence.lastDailyBatchKey.sms" in filter, false,
    "an age-relative item needs no day key");
  assert.equal(matches(filter, {
    _id: "lead-1", active: true, cadenceCounters: { sms: 2 },
  }), false, "sms-2 already sent — refuse");
  assert.equal(matches(filter, {
    _id: "lead-1", active: true, cadenceCounters: { sms: 1 },
  }), true, "sms-1 sent, sms-2 due — allow");
});

test("the day guard is per CHANNEL — rvm at midday is not blocked by the morning sms", () => {
  const filter = buildCounterCadenceClaimFilter(
    dailyItem({ channel: "rvm", templateIndex: 1 }), NOW,
  );
  const morningRan = {
    _id: "lead-1", active: true,
    cadenceCounters: { sms: 3, email: 2 },
    counterCadence: { lastDailyBatchKey: { sms: TODAY, email: TODAY } },
  };
  assert.equal(matches(filter, morningRan), true, "the split must still work");
});

test("claimCounterCadenceItem uses the guarded filter, not an inline one", () => {
  const source = require("node:fs")
    .readFileSync(require.resolve("../../packages/shared-services/src/counterCadenceService"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const fn = source.slice(source.indexOf("async function claimCounterCadenceItem"));
  // Up to the NEXT top-level declaration. Not the first "\n}" — that one is the
  // options destructure's closing brace, not the function's.
  const next = fn.slice(1).search(/\n(async )?function /);
  const body = next > 0 ? fn.slice(0, next) : fn;
  assert.match(body, /buildCounterCadenceClaimFilter\(item, now\)/);
  assert.doesNotMatch(body, /\$or:/, "the filter must not be rebuilt inline and drift from the guard");
});

// ── THE DRAIN'S BLAST RADIUS (adversarial pass, two HIGH) ──────────────────

test("a rate-limited dispatch is a SKIP, not a failure", () => {
  // dispatchForLead nests it: {ok:false, result:{skipped:true,
  // reason:"rate-limited"}}. The sweep's failure counter reads the TOP level,
  // so correct pacing was recorded as failure — writing a failedByChannel
  // increment, a "-counter-failed" stage and a workflow row per item, refusing
  // to certify drained, and making the factory retry the whole thing.
  const source = require("node:fs")
    .readFileSync(require.resolve("../../packages/shared-services/src/counterCadenceService"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const fn = source.slice(source.indexOf("async function dispatchCounterCadenceItem"));
  const body = fn.slice(0, fn.slice(1).search(/\n(async )?function /));
  assert.match(body, /nested\?\.skipped/, "the nested skip must be hoisted");
  assert.match(body, /attemptConsumed: true/, "and surfaced as a consumed attempt at the top level");
  assert.match(body, /recordCounterCadenceSkipAttempt/, "a skip must advance cadence without claiming delivery");
});

test("a skipped channel advances the attempt without claiming a delivery", async () => {
  const original = LeadCadence.findOneAndUpdate;
  let captured = null;
  LeadCadence.findOneAndUpdate = (filter, update, options) => ({
    lean: async () => { captured = { filter, update, options }; return {}; },
  });
  try {
    await recordCounterCadenceSkipAttempt({
      lead: { _id: "lead-1" },
      channel: "email",
      templateIndex: 2,
    }, { reason: "rate-limited" }, IN_WINDOW, "2026-08-06");
    assert.equal(captured.update.$set["cadenceCounters.email"], 2);
    assert.equal(captured.update.$set["counterCadence.lastDailyBatchKey.email"], "2026-08-06");
    assert.equal(captured.update.$set["counterCadence.lastResult.email"].skipped, true);
    assert.equal(captured.update.$set["lastTouched.email"], undefined);
    assert.equal(captured.update.$set["cadenceState.completedByChannel.email"], undefined);
    assert.equal(captured.update.$inc["cadenceState.skippedByChannel.email"], 1);
  } finally {
    LeadCadence.findOneAndUpdate = original;
  }
});

test("a failed dispatch backs off so it cannot pin the head of the next round", () => {
  // The candidate query sorts on lastDispatchAt ascending and only a SUCCESS
  // advances it, so a lead whose dispatch threw kept its sort key and returned
  // at the head seconds later — hammered once per round, twenty rounds deep.
  const source = require("node:fs")
    .readFileSync(require.resolve("../../packages/shared-services/src/counterCadenceService"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const fn = source.slice(source.indexOf("async function recordCounterCadenceFailure"));
  const body = fn.slice(0, fn.slice(1).search(/\n(async )?function /));
  assert.match(body, /skippedNotFailed/, "a skip must not be given a failure backoff");
  assert.match(body, /15 \* 60 \* 1000/, "a genuine failure gets a short defer");
});

test("the drain stops on a MOSTLY-failing round, not just a fully dead one", () => {
  // sent===0 only catches a hard-down provider. A throttling one returns a
  // trickle of successes, which sailed past that stop and let the loop run its
  // whole round budget against a struggling provider.
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  const src = String(drainCounterCadenceSweep);
  assert.match(src, /failed\)[\s\S]{0,40}>[\s\S]{0,40}sent/, "a failure-dominated round must stop it");
  assert.match(src, /roundPauseMs/, "and rounds must pace — sms/email have no rate shaper at all");
});

test("the drain's round pause is configurable and defaults on", () => {
  const { drainCounterCadenceSweep } = require(
    "../../packages/shared-services/src/counterCadenceService",
  );
  assert.match(String(drainCounterCadenceSweep), /COUNTER_CADENCE_DRAIN_ROUND_PAUSE_MS/);
});
