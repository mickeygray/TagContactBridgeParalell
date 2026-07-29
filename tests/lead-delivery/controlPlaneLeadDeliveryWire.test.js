"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { findArmedLegacyVoiceWriters } = require("../../apps/control-plane/src/server");

const DEFAULT_ON_WRITERS = [
  "RC_CX_CADENCE_WORKER_ENABLED",
  "RC_CX_FRESH_HOT_LANE_ENABLED",
  "RC_CX_FRESH_HOT_LANE_IMMEDIATE_ENABLED",
  "CX_APPOINTMENT_WORKER_ENABLED",
  "CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED",
];

test("lead-delivery ownership treats legacy default-on voice writers as armed", () => {
  assert.deepEqual(findArmedLegacyVoiceWriters({}), DEFAULT_ON_WRITERS);
});

test("legacy voice ownership can be made exclusive with explicit false switches", () => {
  const env = Object.fromEntries(DEFAULT_ON_WRITERS.map((name) => [name, "false"]));
  assert.deepEqual(findArmedLegacyVoiceWriters(env), []);
  assert.deepEqual(findArmedLegacyVoiceWriters({ ...env, PACING_QUEUE_ENABLED: "true" }), [
    "PACING_QUEUE_ENABLED",
  ]);
});

test("control plane wires one gated runtime, durable credentials, safe controls, and cleanup", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../apps/control-plane/src/server.js"), "utf8");
  const cadenceActionSource = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/services/leadDeliveryCadenceAction.js"),
    "utf8",
  );
  const dailyDialActionSource = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/services/leadDeliveryDailyDialAction.js"),
    "utf8",
  );
  assert.match(source, /createPhoneBurnerDurableCredentialStore\(\{/);
  assert.match(source, /createLeadDeliveryCadenceSource\(\{/);
  assert.match(source, /createLeadDeliveryRuntime\(\{/);
  assert.match(source, /LEAD_DELIVERY_PROVIDER_POST_MIN_INTERVAL_MS/);
  assert.match(source, /LEAD_DELIVERY_TICK_INTERVAL_MS/);
  assert.match(source, /LEAD_DELIVERY_TICK_INTERVAL_MS\) \|\| 60 \* 1000/);
  assert.match(source, /tickIntervalMs: leadDeliveryTickIntervalMs/);
  assert.match(source, /providerPostMinimumIntervalMs: leadDeliveryProviderPostMinimumIntervalMs/);
  assert.match(source, /acquireProviderPostSlot:[\s\S]*?runLockRepository\.acquireRunLock/);
  assert.match(source, /extendProviderPostSlot:[\s\S]*?runLockRepository\.extendRunLock/);
  assert.match(source, /releaseProviderPostSlot:[\s\S]*?runLockRepository\.releaseRunLock/);
  assert.match(source, /legacyOperatorSurfaceEnabled: false/);
  assert.match(source, /simpleOperatorDirectAccessEnabled: false/);
  assert.match(source, /config: leadDeliveryEnabled[\s\S]*?enabled: false[\s\S]*?config\.phoneburnerRotation/);
  assert.match(source, /leadDeliveryActionsEnabled && !leadDeliveryCallbackCaptureEnabled/);
  assert.doesNotMatch(source, /LEAD_DELIVERY_ACTIONS_ENABLED requires LEAD_WEBHOOK_SECRET/);
  assert.match(source, /callbackAuthentication: "none"/);
  assert.match(source, /createRecordLeadDeliveryDailyDial\(\{ DailyDial \}\)/);
  assert.match(source, /persistDailyDialOutcomes: leadDeliveryActionHandlers\.persist_daily_dials_to_cadence/);
  assert.match(source, /reconcileDailyDialCalls: leadDeliveryActionHandlers\.reconcile_daily_dials_to_call_log/);
  assert.match(dailyDialActionSource, /recordDailyDialOffload/);
  assert.match(dailyDialActionSource, /cadencePersistedAt/);
  assert.match(cadenceActionSource, /leadDeliveryCountedAttemptKeys/);
  assert.match(cadenceActionSource, /lastLeadDeliveryCountedAttemptKey/);
  assert.match(cadenceActionSource, /providerAttemptKey/);
  assert.match(source, /armedLegacyVoiceWriters\.length > 0/);
  assert.match(source, /drainEvent: async \(event\) => leadDeliveryRuntime\.drainCapturedEvent\(event/);
  assert.match(source, /drainEvent:[\s\S]*?waitForRefillCompletion: false/);
  assert.match(source, /drainOnce: async \(options = \{\}\) => leadDeliveryRuntime\.drainEvents/);
  assert.doesNotMatch(source, /onAgentCallEnd\s*:/);
  assert.doesNotMatch(source, /callEndPulseEvery\s*:/);
  assert.doesNotMatch(source, /onAgentLowWater\s*:/);
  assert.doesNotMatch(source, /onFloorLowWater:/);
  assert.match(source, /leadDelivery: \{[\s\S]*?\.\.\.leadDeliveryRuntime\.getState\(\)/);
  assert.match(source, /\/api\/admin\/lead-delivery\/:agentId\/preview/);
  assert.match(source, /\/api\/admin\/lead-delivery\/:agentId\/seed/);
  assert.match(source, /\/api\/admin\/lead-delivery\/:agentId\/launch/);
  assert.match(source, /lead-delivery-simple-loop-only/);
  assert.doesNotMatch(source, /leadDeliveryRuntime\.seedAgent/);
  assert.doesNotMatch(source, /leadDeliveryRuntime\.launchAgent/);
  assert.match(source, /\/api\/admin\/lead-delivery\/:agentId\/cancel/);
  assert.match(source, /if \(leadDeliveryEnabled\) await leadDeliveryRuntime\.start\(\)/);
  assert.match(source, /registerCleanup\("control-plane-lead-delivery"/);
  const dncHandler = source.match(/logics_dnc: async \(action\) => \{[\s\S]*?return \{ ok: true \};/)?.[0] || "";
  assert.match(dncHandler, /skipQueueFinalize: true/);
  assert.doesNotMatch(dncHandler, /queueItemId: action\.itemId/);
  assert.match(source, /PHONEBURNER_PROVIDER_CONSUMPTION_ORDER/);
});
