"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePhoneBurnerCallback,
} = require("../../apps/control-plane/src/routes/phoneBurnerLeadDelivery");

// 2026-07-31: PhoneBurner call events now carry the CRM case id, the agent,
// and a call RECORDING ID. safePayload is a strict whitelist, so anything not
// named here is discarded at the door — which is how 23,722 stored callbacks
// came to hold zero recording evidence between them.
//
// The recording id matters more than a URL: the service account gets a 404 on
// getDialSession for the agents' own sessions, so nothing can be fetched after
// the fact. What rides in on the callback is all there will ever be.

const base = (over = {}) => ({
  call_id: "3050145953",
  contact_id: "9911",
  lead_id: "LD-1",
  event_id: "evt-1",
  status: "answered",
  connected: true,
  duration: 41,
  ds_id: "47357926",
  ...over,
});

const capture = (body, hook = "call-done") => normalizePhoneBurnerCallback(hook, body, {
  receivedAt: new Date("2026-07-31T15:42:13.000Z"),
  payloadDigest: "d".repeat(64),
});

test("a recording id is captured even though it is not a URL", () => {
  const e = capture(base({ recording_id: "rec-88213" }));
  assert.equal(e.safePayload.recordingId, "rec-88213");
  // and it must NOT be mistaken for a URL
  assert.equal(e.safePayload.recordingUrl, null);
});

test("a bare id sitting in a recording URL field is not silently lost", () => {
  // callbackRecordingUrl runs new URL() and returns null for anything that is
  // not https — which is exactly how this value used to disappear.
  const e = capture(base({ recording_url: "88213", recording_id: "88213" }));
  assert.equal(e.safePayload.recordingUrl, null, "not a URL, so not a URL field");
  assert.equal(e.safePayload.recordingId, "88213", "but the id survives");
});

test("a real https recording URL still lands in recordingUrl", () => {
  const e = capture(base({ recording_url: "https://media.example.com/r/88213.mp3" }));
  assert.equal(e.safePayload.recordingUrl, "https://media.example.com/r/88213.mp3");
});

test("an http or credentialed URL is still refused", () => {
  assert.equal(capture(base({ recording_url: "http://media.example.com/a.mp3" })).safePayload.recordingUrl, null);
  assert.equal(capture(base({ recording_url: "https://u:p@media.example.com/a.mp3" })).safePayload.recordingUrl, null);
});

test("the CRM case id is captured, under any of the shapes it may arrive in", () => {
  for (const body of [
    base({ case_id: 430083 }),
    base({ caseId: 430083 }),
    base({ logics_case_id: "430083" }),
    base({ contact: { case_id: 430083 } }),
  ]) {
    assert.equal(capture(body).safePayload.crmCaseId, 430083);
  }
});

test("a missing case id is null, never zero", () => {
  // Zero would join to a real case somewhere downstream.
  const e = capture(base());
  assert.equal(e.safePayload.crmCaseId, null);
});

test("observedKeys records field NAMES and never a value", () => {
  const e = capture(base({ recording_id: "rec-1", case_id: 430083, agent_email: "phil@example.com" }));
  const keys = e.safePayload.observedKeys;
  assert.ok(Array.isArray(keys));
  assert.ok(keys.includes("recording_id"));
  assert.ok(keys.includes("case_id"));
  const blob = JSON.stringify(keys);
  assert.doesNotMatch(blob, /rec-1|430083|phil@example\.com/, "no value may leak into the key list");
});

test("observedKeys reaches one level of nesting and is capped", () => {
  const e = capture(base({ contact: { case_id: 1, lead_id: 2 } }));
  assert.ok(e.safePayload.observedKeys.includes("contact.case_id"));
  assert.ok(e.safePayload.observedKeys.length <= 40);
});

test("the recording hooks still map to call_done so a late URL patches the same event", () => {
  // The file does not exist when the call ends, so "later" is the normal case.
  for (const hook of ["recording", "recording-ready"]) {
    const e = capture(base({ recording_url: "https://media.example.com/x.mp3" }), hook);
    assert.equal(e.eventType, "call_done");
    assert.equal(e.safePayload.recordingUrl, "https://media.example.com/x.mp3");
  }
});

test("capture does not regress the fields the pipeline already relied on", () => {
  const e = capture(base());
  assert.equal(e.safePayload.providerDialSessionId, "47357926");
  assert.equal(e.safePayload.connected, true);
  assert.equal(e.safePayload.durationSeconds, 41);
  assert.equal(e.providerCallId, "3050145953");
});
