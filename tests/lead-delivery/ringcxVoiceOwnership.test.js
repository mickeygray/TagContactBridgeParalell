"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  isLeadDeliveryVoiceOwnerEnabled,
} = require("../../apps/ringcentral-cx/src/server");

test("RingCX legacy voice ownership yields only to an exact true lead-delivery switch", () => {
  assert.equal(isLeadDeliveryVoiceOwnerEnabled({}), false);
  assert.equal(isLeadDeliveryVoiceOwnerEnabled({ LEAD_DELIVERY_ENABLED: "false" }), false);
  assert.equal(isLeadDeliveryVoiceOwnerEnabled({ LEAD_DELIVERY_ENABLED: "1" }), false);
  assert.equal(isLeadDeliveryVoiceOwnerEnabled({ LEAD_DELIVERY_ENABLED: " true " }), true);
  assert.equal(isLeadDeliveryVoiceOwnerEnabled({ LEAD_DELIVERY_ENABLED: "TRUE" }), true);
});

test("RingCX startup keeps legacy queue-building and maintenance workers dark under lead delivery", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../apps/ringcentral-cx/src/server.js"),
    "utf8",
  );

  assert.match(
    source,
    /async function startCxCadenceWorker\(\) \{\s*if \(leadDeliveryOwnsVoice\)[\s\S]*?reason: "lead-delivery-owns-voice"/,
  );
  assert.match(
    source,
    /function startFreshHotLaneWorker\(\) \{\s*if \(leadDeliveryOwnsVoice\)[\s\S]*?reason: "lead-delivery-owns-voice"/,
  );
  assert.match(
    source,
    /function startMorningQueueBuilderWorker\(\)[\s\S]*?const enabled = !leadDeliveryOwnsVoice && isCxMorningQueueBuilderEnabled/,
  );
  assert.match(source, /const pacingQueueEnabled = !leadDeliveryOwnsVoice\s*&&/);
  assert.match(source, /const staleDialSweepEnabled =\s*!leadDeliveryOwnsVoice\s*&& !bulkLoadAlphaRuntime/);
  assert.match(source, /const ringcxAgentMonitorEnabled =\s*!leadDeliveryOwnsVoice\s*&& !bulkLoadAlphaRuntime/);
});

