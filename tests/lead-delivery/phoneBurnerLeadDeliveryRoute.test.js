"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { buildEventDedupeKey } = require("../../packages/shared-services/src/leadDeliveryService");
const {
  createPhoneBurnerLeadDeliveryRuntime,
  normalizePhoneBurnerCallback,
} = require("../../apps/control-plane/src/routes/phoneBurnerLeadDelivery");

const NOW = new Date("2026-07-10T22:00:00.000Z");

function clone(value) {
  return structuredClone(value);
}

function makeRepository({ items = [], insertError = null, invalidInsertResult = false } = {}) {
  const events = [];
  const calls = { inserts: 0, identityReads: 0, drainReads: 0 };
  return {
    events,
    calls,
    async insertEventOnce(input) {
      calls.inserts += 1;
      if (insertError) throw insertError;
      if (invalidInsertResult) return undefined;
      const dedupeKey = buildEventDedupeKey(input);
      const duplicate = events.some((row) => (
        row.dedupeKey === dedupeKey
        || (input.providerEventId && row.providerEventId === input.providerEventId)
      ));
      if (duplicate) return null;
      const row = clone({ _id: `event-${events.length + 1}`, version: 0, ...input, dedupeKey });
      events.push(row);
      return clone(row);
    },
    async findEventByDedupeKey(input) {
      const dedupeKey = buildEventDedupeKey(input);
      return clone(events.find((row) => row.provider === input.provider && row.dedupeKey === dedupeKey) || null);
    },
    async upgradeEventEvidenceCas({ eventId, expectedVersion, expected = {}, set = {} }) {
      const row = events.find((entry) => entry._id === eventId && entry.version === expectedVersion);
      if (!row) return null;
      if (Object.entries(expected).some(([field, value]) => row[field] !== value)) return null;
      Object.assign(row, clone(set));
      row.version += 1;
      return clone(row);
    },
    async listProviderIdentityCandidates(event) {
      calls.identityReads += 1;
      const identities = ["providerExternalLeadId", "providerContactId", "providerCallId"]
        .filter((field) => event[field]);
      return items
        .filter((item) => item.provider === event.provider
          && identities.some((field) => item[field] && item[field] === event[field]))
        .map((item) => ({
          _id: item._id,
          provider: item.provider,
          providerExternalLeadId: item.providerExternalLeadId || null,
          providerContactId: item.providerContactId || null,
          providerCallId: item.providerCallId || null,
          deliveryAgentId: item.deliveryAgentId || null,
          state: item.state,
          activeAttempt: item.activeAttempt,
          version: item.version,
        }));
    },
    async listEventsForDrain({ now = NOW } = {}) {
      calls.drainReads += 1;
      const at = new Date(now).getTime();
      return events.filter((row) => (
        row.status === "pending"
        || (row.status === "failed" && new Date(row.nextAttemptAt).getTime() <= at)
      )).map(clone);
    },
  };
}

async function createHarness(t, options = {}) {
  const repository = options.repository || makeRepository();
  const scheduled = [];
  const logs = [];
  const runtimeOptions = {
    repository,
    now: () => new Date(NOW),
    schedule: options.schedule || ((work) => scheduled.push(work)),
    logger: options.logger || {
      info(event, details) { logs.push({ level: "info", event, details: clone(details) }); },
      warn(event, details) { logs.push({ level: "warn", event, details: clone(details) }); },
    },
  };
  if (!options.omitCaptureEnabled) {
    runtimeOptions.captureEnabled = options.captureEnabled === undefined ? true : options.captureEnabled;
  }
  if (options.allowedAgentIds) runtimeOptions.allowedAgentIds = options.allowedAgentIds;
  if (options.legacyPulseModeEnabled != null) {
    runtimeOptions.legacyCallbackOwnersEnabled = true;
    runtimeOptions.legacyPulseModeEnabled = options.legacyPulseModeEnabled;
  }
  if (options.legacyRouteOwnerEnabled != null) {
    runtimeOptions.legacyCallbackOwnersEnabled = true;
    runtimeOptions.legacyRouteOwnerEnabled = options.legacyRouteOwnerEnabled;
  }
  if (options.callEndPulseEvery != null) runtimeOptions.callEndPulseEvery = options.callEndPulseEvery;
  if (options.onAgentLowWater) runtimeOptions.onAgentLowWater = options.onAgentLowWater;
  if (options.onFloorLowWater) runtimeOptions.onFloorLowWater = options.onFloorLowWater;
  if (options.onAgentCallEnd) runtimeOptions.onAgentCallEnd = options.onAgentCallEnd;
  if (options.drain) runtimeOptions.drain = options.drain;
  const runtime = createPhoneBurnerLeadDeliveryRuntime(runtimeOptions);
  const app = express();
  app.use(express.json({
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use("/api/lead-delivery/phoneburner", runtime.router);
  app.use((_error, _req, res, _next) => res.status(500).json({ ok: false, error: "test-error" }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/lead-delivery/phoneburner`;

  async function post(hook, body, { secret = null, query = "" } = {}) {
    const headers = { "content-type": "application/json" };
    if (secret !== null) headers["x-webhook-key"] = secret;
    const response = await fetch(`${baseUrl}/${hook}${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  return { repository, runtime, scheduled, logs, post };
}

test("capture is dark by default and MVP intake does not require webhook authentication", async (t) => {
  const dark = await createHarness(t, { omitCaptureEnabled: true });
  assert.equal((await dark.post("call-begin", {
    call_id: 1,
    lead_id: "TAG:test:1",
    contact_user_id: 1001,
  })).status, 503);
  assert.equal(dark.repository.events.length, 0);

  const enabled = await createHarness(t);
  assert.equal((await enabled.post("call-begin", {
    call_id: 2,
    lead_id: "TAG:test:2",
    contact_user_id: 1002,
  })).status, 200);
  assert.equal((await enabled.post("call-begin", {
    call_id: 3,
    lead_id: "TAG:test:3",
    contact_user_id: 1003,
  }, { secret: "ignored" })).status, 200);
  assert.equal((await enabled.post("call-begin", {
    call_id: 4,
    lead_id: "TAG:test:4",
    contact_user_id: 1004,
  }, { secret: null, query: "?secret=ignored" })).status, 200);
  assert.equal(enabled.repository.events.length, 3);
});

test("official callback shapes normalize to safe typed fields only", () => {
  const digest = "a".repeat(64);
  const begin = normalizePhoneBurnerCallback("call-begin", {
    call_id: 101,
    lead_id: "TAG:test:101",
    contact_user_id: 501,
    custom_data: { phone: "5555550101", name: "Private" },
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(begin.status, "pending");
  assert.equal(begin.eventType, "call_begin");
  assert.equal(begin.providerCallId, "101");
  assert.equal(begin.providerExternalLeadId, "TAG:test:101");

  const done = normalizePhoneBurnerCallback("call-done", {
    call_id: 102,
    connected: "1",
    duration: "42",
    status: "Left Message",
    contact: {
      user_id: 1102,
      lead_id: "TAG:test:102",
      phone: "5555550102",
      first_name: "Private",
      email: "private@example.invalid",
      notes: "private words",
    },
    recording: "private recording",
    recording_url: "https://recordings.example.invalid/call/102.mp3?token=test",
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(done.status, "pending");
  assert.equal(done.eventType, "call_done");
  assert.equal(done.normalizedOutcome, "voicemail");
  assert.equal(done.safePayload.connected, true);
  assert.equal(done.safePayload.durationSeconds, 42);
  assert.equal(done.safePayload.recordingUrl, "https://recordings.example.invalid/call/102.mp3?token=test");
  const serialized = JSON.stringify(done);
  for (const privateValue of ["5555550102", "Private", "private@example.invalid", "private words", "private recording"]) {
    assert.equal(serialized.includes(privateValue), false);
  }

  const disposition = normalizePhoneBurnerCallback("disposition", {
    call_id: 102,
    lead_id: "TAG:test:102",
    contact: { user_id: 1102 },
    disposition: "Left Message",
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(disposition.eventType, "call_done");
  assert.equal(disposition.safePayload.sourceHook, "disposition");

  const appointment = normalizePhoneBurnerCallback("disposition", {
    call_id: 104,
    lead_id: "TAG:test:104",
    contact: { user_id: 1104 },
    disposition: "Appointment",
    appointment_date: "2026-07-13",
    appointment_time: "14:30",
    appointment_timezone: "America/Los_Angeles",
    appointment_notes: "must not persist",
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(appointment.safePayload.appointment, undefined);
  assert.equal(appointment.normalizedOutcome, "appointment");
  assert.equal(JSON.stringify(appointment).includes("must not persist"), false);

  const appointmentWithoutTime = normalizePhoneBurnerCallback("disposition", {
    call_id: 105,
    lead_id: "TAG:test:105",
    contact: { user_id: 1105 },
    disposition: "Appointment",
    appointment_date: "2026-07-14",
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(appointmentWithoutTime.normalizedOutcome, "appointment");
  assert.equal(appointmentWithoutTime.safePayload.appointment, undefined);

  const displayed = normalizePhoneBurnerCallback("contact-displayed", {
    contact_user_id: 1103,
    lead_id: "TAG:test:103",
  }, { receivedAt: NOW, payloadDigest: digest });
  assert.equal(displayed.status, "review");
  assert.equal(displayed.safePayload.captureReason, "missing-provider-occurrence-identity");
});

test("signed callback is durable before ACK and remains pending while actions are disabled", async (t) => {
  const order = [];
  const repository = makeRepository({ items: [{
    _id: "item-201",
    provider: "phoneburner",
    providerExternalLeadId: "TAG:test:201",
    providerContactId: "1201",
    providerCallId: null,
    normalizedPhone: "5555550199",
    state: "provider_accepted",
    activeAttempt: true,
    version: 0,
  }] });
  const originalInsert = repository.insertEventOnce;
  repository.insertEventOnce = async (event) => {
    order.push("insert-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await originalInsert(event);
    order.push("insert-finished");
    return result;
  };
  const harness = await createHarness(t, {
    repository,
    schedule(work) {
      order.push("scheduled");
      harness.scheduled.push(work);
    },
  });
  const result = await harness.post("call-done", {
    call_id: 201,
    lead_id: "TAG:test:201",
    contact: { user_id: 1201, phone: "5555550100" },
    status: "No Answer",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(order, ["insert-start", "insert-finished", "scheduled"]);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0].status, "pending");
  assert.equal(repository.events[0].attempts, 0);
  assert.equal(JSON.stringify(repository.events[0]).includes("5555550100"), false);

  const preview = await harness.scheduled[0]();
  assert.equal(preview.replayable, true);
  assert.equal(preview.identityResolution, "resolved");
  assert.equal(repository.events[0].status, "pending");
  assert.equal(repository.events[0].attempts, 0);
});

test("general call-done and disposition callbacks dedupe one physical call", async (t) => {
  const harness = await createHarness(t);
  const body = { call_id: 301, lead_id: "TAG:test:301", contact: { user_id: 1301 }, status: "No Answer" };
  const first = await harness.post("call-done", body);
  const duplicate = await harness.post("disposition", { ...body, status: undefined, disposition: "No Answer" });
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(harness.repository.events.length, 1);
  assert.equal(harness.scheduled.length, 2, "new capture previews once and duplicate re-drives the replay scan");
  const accepted = harness.logs.filter((entry) => entry.event === "phoneburner.lead_delivery.callback_accepted");
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted[0].details, {
    sourceHook: "call_done",
    eventType: "call_done",
    normalizedOutcome: "no_answer",
    captureStatus: "pending",
    identityStrength: "call-contact-external",
    hasProviderCallId: true,
    hasProviderContactId: true,
    hasProviderExternalLeadId: true,
    duplicate: false,
    upgraded: false,
    actionsEnabled: false,
  });
  assert.equal(JSON.stringify(accepted).includes("TAG:test:301"), false, "logs must not contain external lead identity");
});

test("production-default Call End schedules one exact drain and no route refill owner", async (t) => {
  const exactDrains = [];
  const routeOwners = [];
  const pulses = [];
  const harness = await createHarness(t, {
    allowedAgentIds: ["chris_bolt"],
    callEndPulseEvery: 1,
    onAgentLowWater: async (input) => {
      pulses.push(input);
      return { status: "legacy-pulse" };
    },
    onFloorLowWater: async (input) => {
      pulses.push(input);
      return { status: "legacy-floor-pulse" };
    },
    onAgentCallEnd: async (input) => {
      routeOwners.push(input);
      return { status: "legacy-route-owner" };
    },
    drain: {
      async drainEvent(event) {
        exactDrains.push(event._id);
        return { status: "processed", seen: 1, processed: 1 };
      },
      async drainOnce() {
        throw new Error("new unique event must not use the broad replay scan");
      },
    },
  });

  const response = await harness.post("call-done/chris_bolt", {
    call_id: 701,
    lead_id: "TAG:test:701",
    contact: { user_id: 1701 },
    status: "No Answer",
  });
  assert.equal(response.status, 200);
  assert.equal(harness.scheduled.length, 1);
  await harness.scheduled[0]();
  assert.deepEqual(exactDrains, ["event-1"]);
  assert.deepEqual(routeOwners, []);
  assert.deepEqual(pulses, []);
  assert.equal(harness.logs.some((entry) => (
    entry.event === "phoneburner.lead_delivery.callback_drained"
    && entry.details.processed === 1
  )), true);
});

test("agent-scoped Call End traffic emits one low-water pulse per five unique calls", async (t) => {
  const pulses = [];
  const harness = await createHarness(t, {
    allowedAgentIds: ["chris_bolt"],
    legacyPulseModeEnabled: true,
    callEndPulseEvery: 5,
    onAgentLowWater: async (input) => {
      pulses.push(input);
      return { status: "posted", accepted: 4 };
    },
  });
  for (let call = 1; call <= 5; call += 1) {
    const response = await harness.post("call-done/chris_bolt", {
      call_id: 800 + call,
      lead_id: `TAG:test:${800 + call}`,
      contact: { user_id: 1800 + call },
    });
    assert.equal(response.status, 200);
  }
  assert.equal(harness.repository.events.every((event) => event.safePayload.sourceAgentId === "chris_bolt"), true);
  assert.equal(harness.scheduled.length, 10, "five agent meters plus five drains run after ACK");
  for (const work of harness.scheduled) await work();
  assert.deepEqual(pulses, [{ agentId: "chris_bolt", observedCallEnds: 5 }]);
  assert.equal(harness.logs.some((entry) => (
    entry.event === "phoneburner.lead_delivery.synthetic_refill"
    && entry.details.accepted === 4
  )), true);

  const invalid = await harness.post("call-done/sean_lucas", {
    call_id: 899,
    lead_id: "TAG:test:899",
  });
  assert.equal(invalid.status, 422);
});

test("agent-scoped review traffic without a physical call ID never advances the meter", async (t) => {
  const pulses = [];
  const harness = await createHarness(t, {
    allowedAgentIds: ["chris_bolt"],
    legacyPulseModeEnabled: true,
    callEndPulseEvery: 1,
    onAgentLowWater: async (input) => {
      pulses.push(input);
      return { status: "posted", accepted: 4 };
    },
  });
  assert.equal((await harness.post("call-done/chris_bolt", {})).status, 200);
  for (const work of harness.scheduled) await work();
  assert.deepEqual(pulses, []);
  assert.equal(harness.logs.some((entry) => entry.event === "phoneburner.lead_delivery.call_end_meter"), false);
});

test("generic Call End traffic emits a floor-wide weighted pulse without agent-specific URLs", async (t) => {
  const pulses = [];
  const harness = await createHarness(t, {
    legacyPulseModeEnabled: true,
    callEndPulseEvery: 5,
    onFloorLowWater: async (input) => {
      pulses.push(input);
      return { status: "posted", accepted: 4, agentId: "brad_hansen" };
    },
  });
  for (let call = 1; call <= 5; call += 1) {
    assert.equal((await harness.post("call-done", {
      call_id: 900 + call,
      lead_id: `TAG:test:${900 + call}`,
      contact: { user_id: 1900 + call },
    })).status, 200);
  }
  for (const work of harness.scheduled) await work();
  assert.deepEqual(pulses, [{ observedCallEnds: 5 }]);
  const refill = harness.logs.find((entry) => entry.event === "phoneburner.lead_delivery.synthetic_refill");
  assert.equal(refill.details.scope, "floor");
  assert.equal(refill.details.agentId, "brad_hansen");
  assert.equal(refill.details.accepted, 4);
});

test("generic Call End traffic resolves the persisted delivery agent before advancing its meter", async (t) => {
  const pulses = [];
  const items = Array.from({ length: 5 }, (_, index) => ({
    _id: `item-generic-${index + 1}`,
    provider: "phoneburner",
    providerExternalLeadId: `TAG:test:${1001 + index}`,
    providerContactId: String(2001 + index),
    providerCallId: null,
    deliveryAgentId: "brad_hansen",
    state: "provider_accepted",
    activeAttempt: true,
    version: 0,
  }));
  const harness = await createHarness(t, {
    repository: makeRepository({ items }),
    allowedAgentIds: ["chris_bolt", "brad_hansen"],
    legacyPulseModeEnabled: true,
    callEndPulseEvery: 5,
    onAgentLowWater: async (input) => {
      pulses.push(input);
      return { status: "posted", accepted: 4 };
    },
  });
  for (let index = 0; index < items.length; index += 1) {
    assert.equal((await harness.post("call-done", {
      call_id: 1001 + index,
      lead_id: `TAG:test:${1001 + index}`,
      contact: { user_id: 2001 + index },
    })).status, 200);
  }
  for (const work of harness.scheduled) await work();
  assert.deepEqual(pulses, [{ agentId: "brad_hansen", observedCallEnds: 5 }]);
  assert.equal(harness.repository.events.every((event) => event.safePayload.sourceAgentId === null), true);
  assert.equal(harness.logs.some((entry) => (
    entry.event === "phoneburner.lead_delivery.synthetic_refill"
    && entry.details.scope === "agent"
    && entry.details.agentId === "brad_hansen"
    && entry.details.accepted === 4
  )), true);
});

test("a known disposition upgrades an earlier unknown call-done without recounting the call", async (t) => {
  const harness = await createHarness(t);
  const first = await harness.post("call-done", {
    call_id: 302,
    lead_id: "TAG:test:302",
    contact: { user_id: 1302 },
    status: "Unmapped Provider Label containing Private Words",
  });
  assert.equal(first.status, 200);
  assert.equal(harness.repository.events[0].status, "pending");
  assert.equal(JSON.stringify(harness.repository.events[0]).includes("Private Words"), false);

  const stronger = await harness.post("disposition", {
    call_id: 302,
    lead_id: "TAG:test:302",
    contact: { user_id: 1302 },
    disposition: "DNC",
  });
  assert.equal(stronger.status, 200);
  assert.equal(stronger.body.upgraded, true);
  assert.equal(harness.repository.events.length, 1);
  assert.equal(harness.repository.events[0].status, "pending");
  assert.equal(harness.repository.events[0].normalizedOutcome, "dnc");
  assert.equal(harness.repository.events[0].version, 1);
});

test("exactly identified unknown Call End remains processable while phone-only input stays review without PII", async (t) => {
  const harness = await createHarness(t);
  const unknown = await harness.post("call-done", {
    call_id: 401,
    lead_id: "TAG:test:401",
    contact: { user_id: 1401 },
    status: "Unmapped Provider Label",
  });
  const phoneOnly = await harness.post("call-done", {
    phone: "5555550140",
    first_name: "Private",
    status: "No Answer",
  });
  assert.equal(unknown.status, 200);
  assert.equal(phoneOnly.status, 200);
  assert.equal(harness.repository.events.length, 2);
  assert.deepEqual(harness.repository.events.map((row) => row.status), ["pending", "review"]);
  assert.equal(harness.repository.events[0].normalizedOutcome, "review");
  assert.equal(harness.repository.events[1].safePayload.captureReason, "missing-hard-provider-identity");
  const serialized = JSON.stringify(harness.repository.events);
  assert.equal(serialized.includes("5555550140"), false);
  assert.equal(serialized.includes("Private"), false);
  assert.equal(serialized.includes("Unmapped Provider Label"), false);
  assert.equal(harness.scheduled.length, 1);
});

test("call-less contact display uses review-only digest dedupe", async (t) => {
  const harness = await createHarness(t);
  const body = { contact_user_id: 1501, lead_id: "TAG:test:501", phone: "5555550150" };
  const first = await harness.post("contact-displayed", body);
  const second = await harness.post("contact-displayed", body);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(harness.repository.events.length, 1);
  assert.equal(harness.repository.events[0].status, "review");
  assert.match(harness.repository.events[0].dedupeKey, /^v1:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(harness.repository.events[0]).includes("5555550150"), false);
});

test("replay resolves exact IDs only and never mutates pending or failed rows", async (t) => {
  const repository = makeRepository({ items: [
    {
      _id: "exact",
      provider: "phoneburner",
      providerExternalLeadId: "TAG:test:601",
      providerContactId: "1601",
      providerCallId: null,
      normalizedPhone: "5555550160",
      state: "provider_accepted",
      activeAttempt: true,
      version: 0,
    },
    {
      _id: "same-phone-wrong-id",
      provider: "phoneburner",
      providerExternalLeadId: "TAG:test:699",
      providerContactId: "1699",
      providerCallId: "699",
      normalizedPhone: "5555550160",
      state: "provider_accepted",
      activeAttempt: true,
      version: 0,
    },
  ] });
  const harness = await createHarness(t, { repository });
  await harness.post("call-begin", {
    call_id: 601,
    lead_id: "TAG:test:601",
    contact: { user_id: 1601 },
  });
  const replay = await harness.runtime.drainOnce();
  assert.equal(replay.scanned, 1);
  assert.equal(replay.resolved, 1);
  assert.equal(repository.events[0].status, "pending");
  assert.equal(repository.events[0].attempts, 0);

  const failed = { ...clone(repository.events[0]), _id: "event-failed", status: "failed", nextAttemptAt: new Date(NOW) };
  const failedPreview = await harness.runtime.drainEvent(failed);
  assert.equal(failedPreview.replayable, true);
  assert.equal(failedPreview.identityResolution, "resolved");
  assert.equal(failed.status, "failed");
});

test("ACK is prompt despite a never-resolving disabled drain", async (t) => {
  const never = new Promise(() => {});
  const harness = await createHarness(t, {
    drain: { drainEvent: () => never, drainOnce: () => never },
    schedule: (work) => work(),
  });
  const response = await Promise.race([
    harness.post("call-begin", {
      call_id: 701,
      lead_id: "TAG:test:701",
      contact: { user_id: 1701 },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("callback ACK timed out")), 1_000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(harness.repository.events.length, 1);
  assert.equal(harness.repository.events[0].status, "pending");
});

test("persistence failure or invalid repository result is never falsely acknowledged", async (t) => {
  const failed = await createHarness(t, { repository: makeRepository({ insertError: new Error("private database detail") }) });
  assert.equal((await failed.post("call-begin", { call_id: 801, lead_id: "TAG:test:801" })).status, 503);
  const invalid = await createHarness(t, { repository: makeRepository({ invalidInsertResult: true }) });
  assert.equal((await invalid.post("call-begin", { call_id: 802, lead_id: "TAG:test:802" })).status, 503);
});

test("server wire is after raw-body parsers, dark by default, and free of legacy machinery", () => {
  const routeSource = fs.readFileSync(path.join(
    __dirname,
    "../../apps/control-plane/src/routes/phoneBurnerLeadDelivery.js",
  ), "utf8");
  const serverSource = fs.readFileSync(path.join(__dirname, "../../apps/control-plane/src/server.js"), "utf8");
  const nginxSource = fs.readFileSync(path.join(__dirname, "../../ops/nginx/parallel.conf"), "utf8");
  assert.doesNotMatch(routeSource, /\b(?:CxDialQueue|QueueItem|normalizedPhone|RingCX|UCQ|compareAndSetEvent|Logics)\b/);
  assert.match(serverSource, /LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED\s*\|\|\s*"false"/);
  assert.match(serverSource, /createPhoneBurnerLeadDeliveryRuntime\(\{[\s\S]*?captureEnabled:/);
  const jsonParser = serverSource.indexOf("app.use(express.json");
  const mount = serverSource.indexOf('"/api/lead-delivery/phoneburner"');
  assert.ok(jsonParser >= 0 && mount > jsonParser, "callback mount must follow raw-body capture parsers");
  const publicBlock = nginxSource.match(/location \^~ \/api\/lead-delivery\/phoneburner\/ \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(publicBlock, /proxy_pass http:\/\/parallel_cp/);
  assert.doesNotMatch(publicBlock, /auth_request/);
});

// ── late-arriving recordings (Mickey 2026-07-28) ─────────────────────────
// "this has to be forward looking so basically keep it in the call end hook
// and then pull it when its ready."
//
// The recording does not exist when the call ends — it is still being
// written. So the URL arrives on a LATER callback, and the hook must accept
// it from whichever one carries it. Gating extraction on call_done silently
// dropped every late URL, which is why 18,187 call_done events carried zero
// recordings.
test("a recording URL is captured from ANY callback, not just call_done", () => {
  const routeSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../apps/control-plane/src/routes/phoneBurnerLeadDelivery.js"),
    "utf8",
  );
  const gated = /recordingUrl:\s*hook\.eventType\s*===\s*"call_done"/.test(routeSrc);
  assert.equal(gated, false, "extraction must not be gated on the call_done event type");
  assert.match(routeSrc, /recordingUrl:\s*callbackRecordingUrl\(/, "the URL is taken from the body unconditionally");
});

test("dedicated recording callbacks are registered and map to call_done", () => {
  const routeSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../apps/control-plane/src/routes/phoneBurnerLeadDelivery.js"),
    "utf8",
  );
  // Mapping to call_done is what lets buildCapturedEventUpgrade patch the
  // URL onto the EXISTING attempt rather than creating a second event —
  // the upgrade path requires matching eventType.
  for (const hook of ["recording", "recording-ready"]) {
    assert.ok(routeSrc.includes(`"${hook}"`) || routeSrc.includes(`${hook}:`), `${hook} hook must be registered`);
  }
  const recordingLines = routeSrc.split("\n").filter((l) => /recording(-ready)?["']?:\s*Object\.freeze/.test(l));
  assert.ok(recordingLines.length >= 2, "both recording hooks present");
  for (const line of recordingLines) {
    assert.match(line, /eventType:\s*"call_done"/, "recording hooks must map to call_done for the upgrade path");
  }
});
