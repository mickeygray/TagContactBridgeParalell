"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OUTBOUND_EVENT_TYPES,
  buildCadenceSweepChecks,
  buildOutboundHandlers,
} = require("../../packages/shared-services/src/outboundDispatchService");

test("lead-delivery ownership removes only CX from the cadence sweep", () => {
  assert.deepEqual(
    buildCadenceSweepChecks({ leadDeliveryEnabled: true }).map((entry) => entry.channel),
    ["sms", "email", "rvm"],
  );
  assert.deepEqual(
    buildCadenceSweepChecks({ leadDeliveryEnabled: false }).map((entry) => entry.channel),
    ["sms", "email", "rvm", "cx"],
  );
});

test("queued CX and legacy PhoneBurner work drain as no-ops while nonvoice rounds keep dispatching", async () => {
  const calls = [];
  const handlers = buildOutboundHandlers({
    leadDeliveryEnabled: true,
    runRoundHandler: async (payload, channel) => {
      calls.push({ payload, channel });
      return { ok: true };
    },
  });

  const skipped = await handlers[OUTBOUND_EVENT_TYPES.CX_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  assert.deepEqual(skipped, { ok: true, skipped: true, reason: "lead-delivery-owns-voice" });
  assert.deepEqual(
    await handlers[OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED]({ payload: { domain: "TAG" } }),
    { ok: true, skipped: true, reason: "lead-delivery-owns-phoneburner" },
  );
  assert.deepEqual(
    await handlers[OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED]({ payload: { domain: "TAG" } }),
    { ok: true, skipped: true, reason: "lead-delivery-owns-phoneburner" },
  );
  assert.equal(calls.length, 0);

  await handlers[OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  await handlers[OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  await handlers[OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  assert.deepEqual(calls.map((entry) => entry.channel), ["sms", "email", "rvm"]);
});

test("legacy CX and PhoneBurner dispatch remain available while lead delivery is dark", async () => {
  const calls = [];
  const handlers = buildOutboundHandlers({
    leadDeliveryEnabled: false,
    runRoundHandler: async (payload, channel) => {
      calls.push({ payload, channel });
      return { ok: true };
    },
    runManualHandler: async (payload, channel) => {
      calls.push({ payload, channel });
      return { ok: true };
    },
  });

  await handlers[OUTBOUND_EVENT_TYPES.CX_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  await handlers[OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED]({ payload: { domain: "TAG" } });
  await handlers[OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED]({ payload: { domain: "TAG" } });
  assert.deepEqual(calls.map((entry) => entry.channel), ["cx", "phoneburner", "phoneburner"]);
});

test("outbound HTTP intake rejects legacy PhoneBurner work under the new owner", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../apps/outbound-gateway/src/server.js"), "utf8");
  assert.match(source, /\/api\/outbound\/cadence\/phoneburner-round[\s\S]*?lead-delivery-owns-phoneburner/);
  assert.match(source, /\/api\/outbound\/manual\/phoneburner[\s\S]*?lead-delivery-owns-phoneburner/);
});
