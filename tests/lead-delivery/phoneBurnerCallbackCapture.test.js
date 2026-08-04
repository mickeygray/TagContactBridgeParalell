"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePhoneBurnerCallback,
} = require("../../apps/control-plane/src/routes/phoneBurnerLeadDelivery");

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
  allowedRecordingHosts: ["media.example.com"],
});

test("a recording id is captured independently from a URL", () => {
  const e = capture(base({ recording_id: "rec-88213" }));
  assert.equal(e.safePayload.recordingId, "rec-88213");
  assert.equal(e.safePayload.recordingUrl, null);
  assert.equal(e.safePayload.recordingCandidateStatus, "absent");
});

test("a bare id sitting in a recording URL field is retained as unparsed evidence", () => {
  const e = capture(base({ recording_url: "88213", recording_id: "88213" }));
  assert.equal(e.safePayload.recordingUrl, null);
  assert.equal(e.safePayload.recordingId, "88213");
  assert.equal(e.safePayload.recordingCandidateStatus, "retained_unparsed");
  assert.equal(e.safePayload.recordingReference, "88213");
  assert.equal(e.safePayload.recordingReferenceSourceKey, "recording_url");
});

test("a real https recording URL lands in recordingUrl", () => {
  const e = capture(base({ recording_url: "https://media.example.com/r/88213.mp3" }));
  assert.equal(e.safePayload.recordingUrl, "https://media.example.com/r/88213.mp3");
  assert.equal(e.safePayload.recordingSourceKey, "recording_url");
  assert.equal(e.safePayload.recordingCandidateStatus, "captured");
});

test("every supported recording URL alias captures independently", () => {
  const url = "https://media.example.com/r/alias.mp3?signature=kept";
  const aliases = [
    ["recording_url_public", { recording_url_public: url }],
    ["recording_link_public", { recording_link_public: url }],
    ["recording_url", { recording_url: url }],
    ["recording_link", { recording_link: url }],
    ["recordingUrlPublic", { recordingUrlPublic: url }],
    ["recordingLinkPublic", { recordingLinkPublic: url }],
    ["recordingUrl", { recordingUrl: url }],
    ["recordingLink", { recordingLink: url }],
    ["recording.url_public", { recording: { url_public: url } }],
    ["recording.link_public", { recording: { link_public: url } }],
    ["recording.url", { recording: { url } }],
    ["recording.link", { recording: { link: url } }],
    ["call.recording_url_public", { call: { recording_url_public: url } }],
    ["call.recording_link_public", { call: { recording_link_public: url } }],
    ["call.recording_url", { call: { recording_url: url } }],
    ["call.recording_link", { call: { recording_link: url } }],
    ["audio_url", { audio_url: url }],
    ["recording", { recording: url }],
  ];
  for (const [sourceKey, shape] of aliases) {
    const e = capture(base(shape));
    assert.equal(e.safePayload.recordingUrl, url, sourceKey);
    assert.equal(e.safePayload.recordingSourceKey, sourceKey, sourceKey);
  }
});

test("blank or invalid early aliases do not hide a later valid URL", () => {
  const e = capture(base({
    recording_url_public: "not-a-url",
    recording_link_public: "",
    recording_url: "https://media.example.com/r/later.mp3",
  }));
  assert.equal(e.safePayload.recordingUrl, "https://media.example.com/r/later.mp3");
  assert.equal(e.safePayload.recordingSourceKey, "recording_url");
  assert.equal(e.safePayload.recordingReference, null);
  assert.equal(e.safePayload.recordingReferenceSourceKey, null);
});

test("the first nonempty scalar alias is retained when no candidate validates", () => {
  const e = capture(base({
    recording_url_public: "provider-value-one",
    recording_link_public: "provider-value-two",
  }));
  assert.equal(e.safePayload.recordingUrl, null);
  assert.equal(e.safePayload.recordingCandidateStatus, "retained_unparsed");
  assert.equal(e.safePayload.recordingReference, "provider-value-one");
  assert.equal(e.safePayload.recordingReferenceSourceKey, "recording_url_public");
});

test("non-scalar and oversized recording candidates are not retained", () => {
  const nonScalar = capture(base({ recording_url: { private: "value" } }));
  assert.equal(nonScalar.safePayload.recordingCandidateStatus, "invalid");
  assert.equal(nonScalar.safePayload.recordingReference, null);

  const oversized = capture(base({ recording_url: "x".repeat(4097) }));
  assert.equal(oversized.safePayload.recordingCandidateStatus, "invalid");
  assert.equal(oversized.safePayload.recordingReference, null);
});

test("an unparsed recording value appears only in its private safePayload field", () => {
  const privateReference = "provider-private-reference";
  const e = capture(base({ recording_link: privateReference }));
  assert.equal(e.safePayload.recordingReference, privateReference);
  const redactedSafePayload = { ...e.safePayload, recordingReference: "<redacted>" };
  assert.doesNotMatch(JSON.stringify({ ...e, safePayload: redactedSafePayload }), /provider-private-reference/);
});

test("a valid public alias is preferred over a legacy alias", () => {
  const e = capture(base({
    recording_url_public: "https://media.example.com/r/public.mp3",
    recording_url: "https://media.example.com/r/legacy.mp3",
  }));
  assert.equal(e.safePayload.recordingUrl, "https://media.example.com/r/public.mp3");
  assert.equal(e.safePayload.recordingSourceKey, "recording_url_public");
});

test("unsafe or unauthorized recording URLs fail closed", () => {
  assert.equal(capture(base({ recording_url: "http://media.example.com/a.mp3" })).safePayload.recordingUrl, null);
  assert.equal(capture(base({ recording_url: "https://u:p@media.example.com/a.mp3" })).safePayload.recordingUrl, null);
  assert.equal(capture(base({ recording_url: "https://unapproved.example/a.mp3" })).safePayload.recordingUrl, null);
  assert.equal(capture(base({ recording_url: `https://media.example.com/${"a".repeat(2050)}` })).safePayload.recordingUrl, null);

  const privateEvent = normalizePhoneBurnerCallback("call-done", base({
    recording_url: "https://10.0.0.1/a.mp3",
  }), {
    receivedAt: new Date("2026-07-31T15:42:13.000Z"),
    payloadDigest: "d".repeat(64),
    allowedRecordingHosts: ["10.0.0.1"],
  });
  assert.equal(privateEvent.safePayload.recordingUrl, null);
});

test("raw recording URL appears only in the whitelisted safePayload field", () => {
  const url = "https://media.example.com/r/only-here.mp3?signature=preserved";
  const e = capture(base({ recording_link: url }));
  assert.equal(e.safePayload.recordingUrl, url);
  const redactedSafePayload = { ...e.safePayload, recordingUrl: "<redacted>" };
  assert.doesNotMatch(JSON.stringify({ ...e, safePayload: redactedSafePayload }), /only-here|signature=preserved/);
});

test("the CRM case id is captured, under supported shapes", () => {
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
  assert.equal(capture(base()).safePayload.crmCaseId, null);
});

test("observedKeys records field names and never values", () => {
  const e = capture(base({ recording_id: "rec-1", case_id: 430083, agent_email: "phil@example.com" }));
  const keys = e.safePayload.observedKeys;
  assert.ok(Array.isArray(keys));
  assert.ok(keys.includes("recording_id"));
  assert.ok(keys.includes("case_id"));
  assert.doesNotMatch(JSON.stringify(keys), /rec-1|430083|phil@example\.com/);
});

test("observedKeys reaches one level of nesting and is capped", () => {
  const e = capture(base({ contact: { case_id: 1, lead_id: 2 } }));
  assert.ok(e.safePayload.observedKeys.includes("contact.case_id"));
  assert.ok(e.safePayload.observedKeys.length <= 40);
});

test("recording hooks map to call_done so late evidence patches the same event", () => {
  for (const hook of ["recording", "recording-ready"]) {
    const e = capture(base({ recording_url: "https://media.example.com/x.mp3" }), hook);
    assert.equal(e.eventType, "call_done");
    assert.equal(e.safePayload.recordingUrl, "https://media.example.com/x.mp3");
  }
});

test("capture retains established pipeline fields", () => {
  const e = capture(base());
  assert.equal(e.safePayload.providerDialSessionId, "47357926");
  assert.equal(e.safePayload.connected, true);
  assert.equal(e.safePayload.durationSeconds, 41);
  assert.equal(e.providerCallId, "3050145953");
});
