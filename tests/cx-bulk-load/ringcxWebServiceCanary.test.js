"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  createRingcxWebServiceCanaryRouter,
  parseAllowedCampaignIds,
  safeEnvelope,
} = require("../../apps/control-plane/src/routes/ringcxWebServiceCanary");

test("campaign allowlist defaults to Parallel Test and accepts explicit floor campaigns", () => {
  assert.deepEqual([...parseAllowedCampaignIds("")], ["2306"]);
  assert.deepEqual([...parseAllowedCampaignIds("2306, 1001,1002")], ["2306", "1001", "1002"]);
});

test("safeEnvelope keeps identifiers/dispositions and drops contact data", () => {
  const result = safeEnvelope({
    campaign_id: "2306",
    extern_id: "cx-test-1",
    agent_disposition: "DNC CANARY",
    phone: "3105551212",
    first_name: "Private",
  });
  assert.deepEqual(result.fields, {
    campaign_id: "2306",
    extern_id: "cx-test-1",
    agent_disposition: "DNC CANARY",
  });
  assert.deepEqual(result.keys, ["agent_disposition", "campaign_id", "extern_id", "first_name", "phone"]);
});

test("route accepts only campaign 2306 and deduplicates identical delivery bodies", async () => {
  const writes = [];
  const collection = () => ({
    async updateOne(filter, update) {
      writes.push({ filter, update });
      return { upsertedCount: writes.length === 1 ? 1 : 0 };
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/hook", createRingcxWebServiceCanaryRouter({ collection, expectedSecret: "test-secret" }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/hook`;
    const unauthorized = await fetch(`${base}?campaignId=2306`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const headers = { "content-type": "application/json", "x-webhook-key": "test-secret" };
    const blocked = await fetch(`${base}?campaignId=9999`, { method: "POST", headers, body: "{}" });
    assert.equal(blocked.status, 403);
    const body = JSON.stringify({ campaign_id: "2306", extern_id: "x", disposition: "TEST" });
    const first = await fetch(`${base}?campaignId=2306`, { method: "POST", headers, body });
    const second = await fetch(`${base}?campaignId=2306`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).duplicate, false);
    assert.equal((await second.json()).duplicate, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].filter.hash, writes[1].filter.hash);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("processor failure is captured and ACKed so RingCX is never held open", async () => {
  const collection = () => ({ async updateOne() { return { upsertedCount: 1 }; } });
  const app = express();
  app.use(express.json());
  app.use("/hook", createRingcxWebServiceCanaryRouter({
    collection,
    expectedSecret: "test-secret",
    processingEnabled: true,
    processor: { async ingest() { throw new Error("downstream unavailable"); } },
    logger: { warn() {} },
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/hook?campaignId=2306`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-key": "test-secret" },
      body: JSON.stringify({ extern_id: "cx-direct-wynn-1", uii: "u1" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.processing.accepted, false);
    assert.equal(body.processing.reason, "processor-failed-captured-for-replay");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
