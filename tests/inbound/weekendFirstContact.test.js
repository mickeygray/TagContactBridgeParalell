"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChannelPolicy,
  evaluateChannelContactTime,
} = require("../../packages/shared-services/src/contactTimingPolicyService");
const {
  fireImmediateContact,
} = require("../../packages/shared-services/src/inboundIntakeService");
const counterCadence = require("../../packages/shared-services/src/counterCadenceService");
const outboundDispatch = require("../../packages/shared-services/src/outboundDispatchService");

test("initial SMS is eligible during the daytime weekend contact window", () => {
  const policy = buildChannelPolicy("TAG", "sms", { initialContact: true });
  assert.equal(policy.activeWeekdays, "0,1,2,3,4,5,6");
  // Saturday 2026-08-08 10:00 Pacific.
  const decision = evaluateChannelContactTime(
    "TAG",
    "sms",
    new Date("2026-08-08T17:00:00.000Z"),
    { initialContact: true },
  );
  assert.equal(decision.allowed, true);
});

test("immediate first contact sends only SMS/email and consumes a provider skip", async (t) => {
  const originalDispatch = outboundDispatch.dispatchForLead;
  const originalTouch = counterCadence.recordCounterCadenceTouch;
  const originalSkip = counterCadence.recordCounterCadenceSkipAttempt;
  t.after(() => {
    outboundDispatch.dispatchForLead = originalDispatch;
    counterCadence.recordCounterCadenceTouch = originalTouch;
    counterCadence.recordCounterCadenceSkipAttempt = originalSkip;
  });

  const dispatches = [];
  const touches = [];
  const skips = [];
  outboundDispatch.dispatchForLead = async (_lead, options) => {
    dispatches.push(options);
    return options.channel === "sms"
      ? { ok: false, result: { skipped: true, reason: "rate-limited" } }
      : { ok: true, result: { accepted: true } };
  };
  counterCadence.recordCounterCadenceTouch = async (value) => { touches.push(value); };
  counterCadence.recordCounterCadenceSkipAttempt = async (...value) => { skips.push(value); };

  const result = await fireImmediateContact({
    _id: "lead-cadence-test",
    domain: "TAG",
    caseId: 123,
  }, {
    phoneCanText: true,
    emailCanSend: true,
    phoneCanCall: true,
  });

  assert.deepEqual(dispatches.map((entry) => entry.channel), ["sms", "email"]);
  assert.equal(dispatches.every((entry) => entry.initialContact === true), true);
  assert.equal(touches.length, 1);
  assert.equal(touches[0].channel, "email");
  assert.equal(skips.length, 1);
  assert.equal(skips[0][0].channel, "sms");
  assert.equal(skips[0][1].reason, "rate-limited");
  assert.equal(result.cx.reason, "cx-dial-queue-retired");
});

test("an unavailable first-contact channel is also consumed instead of retried", async (t) => {
  const originalDispatch = outboundDispatch.dispatchForLead;
  const originalSkip = counterCadence.recordCounterCadenceSkipAttempt;
  t.after(() => {
    outboundDispatch.dispatchForLead = originalDispatch;
    counterCadence.recordCounterCadenceSkipAttempt = originalSkip;
  });

  const skips = [];
  outboundDispatch.dispatchForLead = async () => {
    throw new Error("dispatch must not run for unavailable channels");
  };
  counterCadence.recordCounterCadenceSkipAttempt = async (...value) => { skips.push(value); };

  await fireImmediateContact({
    _id: "lead-cadence-test",
    domain: "TAG",
    caseId: 123,
  }, {
    phoneCanText: false,
    emailCanSend: false,
    phoneCanCall: false,
  });

  assert.deepEqual(skips.map((entry) => entry[0].channel), ["sms", "email"]);
  assert.deepEqual(skips.map((entry) => entry[1].reason), [
    "phone-cannot-text",
    "email-cannot-send",
  ]);
});
