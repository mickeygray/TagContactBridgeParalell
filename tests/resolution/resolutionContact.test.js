"use strict";

process.env.RESOLUTION_BULK_MAX = "2"; // set BEFORE require so the cap is testable

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sendUpsellContact,
  sendBulkUpsellContact,
  renderUpsellTemplate,
  isRecentDuplicate,
} = require("../../packages/shared-services/src/resolutionContactService");

// Fake deps: a contactable paid client (TAG tier-1 206), plus gating controls.
function makeDeps(overrides = {}) {
  const calls = { text: [], email: [], record: [] };
  const deps = {
    findCaseProfile: async (domain, caseId) => ({
      domain, caseId, statusId: 206,
      primaryPhone: "5551234567", email: "c@example.com", firstName: "Ann", lastName: "Lee",
      conversationAi: { optOutDetected: false },
      ...(overrides.caseProfile || {}),
    }),
    resolveStatus: () => ({ category: overrides.statusCategory || "tier1" }),
    resolveUpsellContactEligibility: ({ caseId }) => (
      overrides.block ? { ok: false, reason: overrides.block } : { ok: true }
    ),
    sendText: async (a) => { calls.text.push(a); return overrides.textResult || { ok: true, messageId: "t1" }; },
    sendEmail: async (a) => { calls.email.push(a); return overrides.emailResult || { ok: true, id: "e1" }; },
    appendCommunicationEntry: async (...a) => { calls.record.push(a); },
    ...overrides.deps,
  };
  return { calls, deps };
}

// ── single send: goes DIRECT to the transport, never to dispatchForLead ───────
test("sendUpsellContact: SMS sends direct via outboundText with the right phone/case + records", async () => {
  const { calls, deps } = makeDeps();
  const r = await sendUpsellContact({ domain: "TAG", caseId: 100, channel: "sms", content: "hi", actor: "me@x.com" }, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.text.length, 1);
  assert.deepEqual(calls.text[0], { domain: "TAG", toPhone: "5551234567", content: "hi", caseId: 100 });
  assert.equal(calls.email.length, 0);
  assert.equal(calls.record.length, 1);
});

test("sendUpsellContact: email sends direct via outboundEmail with subject/text/name", async () => {
  const { calls, deps } = makeDeps();
  const r = await sendUpsellContact({ domain: "TAG", caseId: 100, channel: "email", subject: "Hi", content: "body" }, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.email.length, 1);
  assert.equal(calls.email[0].toEmail, "c@example.com");
  assert.equal(calls.email[0].subject, "Hi");
  assert.equal(calls.email[0].text, "body");
  assert.equal(calls.email[0].name, "Ann Lee");
});

test("sendUpsellContact: renders supported merge fields before transport + record", async () => {
  const { calls, deps } = makeDeps();
  const r = await sendUpsellContact({
    domain: "TAG",
    caseId: 100,
    channel: "sms",
    content: "Hi {firstName}, case {caseId} at {domain}",
  }, deps);
  assert.equal(r.ok, true);
  assert.equal(calls.text[0].content, "Hi Ann, case 100 at TAG");
  assert.equal(calls.record[0][3].body, "Hi Ann, case 100 at TAG");
});

test("renderUpsellTemplate: leaves unknown merge fields visible", () => {
  const out = renderUpsellTemplate("Hi {firstName} {unknown}", { firstName: "Ann" }, { domain: "TAG", caseId: 7 });
  assert.equal(out, "Hi Ann {unknown}");
});

test("sendUpsellContact: blocked by the upsell gate → skipped, nothing sent", async () => {
  const { calls, deps } = makeDeps({ block: "allowlist-required" });
  const r = await sendUpsellContact({ domain: "TAG", caseId: 100, channel: "sms", content: "hi" }, deps);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "allowlist-required");
  assert.equal(calls.text.length, 0);
  assert.equal(calls.record.length, 0);
});

test("sendUpsellContact: dryRun previews to the resolved recipient, no send", async () => {
  const { calls, deps } = makeDeps();
  const r = await sendUpsellContact({ domain: "TAG", caseId: 100, channel: "sms", content: "hi", dryRun: true }, deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.to, "5551234567");
  assert.equal(calls.text.length, 0);
});

test("sendUpsellContact: unsupported channel / missing phone / empty content all skip cleanly", async () => {
  assert.equal((await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "rvm", content: "x" }, makeDeps().deps)).reason, "unsupported-channel");
  const noPhone = makeDeps({ caseProfile: { primaryPhone: null, normalizedPhones: [] } });
  assert.equal((await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "sms", content: "x" }, noPhone.deps)).reason, "no-phone");
  const empty = makeDeps();
  assert.equal((await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "sms", content: "   " }, empty.deps)).reason, "empty-content");
});

test("sendUpsellContact: case not found → ok:false", async () => {
  const { deps } = makeDeps();
  deps.findCaseProfile = async () => null;
  const r = await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "sms", content: "x" }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "case-not-found");
});

test("sendUpsellContact: a failed transport send is not recorded as sent", async () => {
  const { calls, deps } = makeDeps({ textResult: { ok: false, reason: "callrail-not-configured" } });
  const r = await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "sms", content: "x" }, deps);
  assert.equal(r.ok, false);
  assert.equal(calls.record.length, 0);
});

// ── idempotency (no duplicate identical sends) ────────────────────────────────
test("isRecentDuplicate: matches same channel+body in window, ignores old / different / empty", () => {
  const now = new Date("2026-06-16T12:00:00Z");
  const fresh = { source: "resolution-upsell", channel: "sms", body: "hi", happenedAt: "2026-06-16T11:00:00Z" };
  const old = { source: "resolution-upsell", channel: "sms", body: "hi", happenedAt: "2026-06-15T00:00:00Z" };
  assert.equal(isRecentDuplicate({ communications: [fresh] }, { channel: "sms", content: "hi", now }), true);
  assert.equal(isRecentDuplicate({ communications: [old] }, { channel: "sms", content: "hi", now }), false);
  assert.equal(isRecentDuplicate({ communications: [fresh] }, { channel: "sms", content: "different", now }), false);
  assert.equal(isRecentDuplicate({ communications: [fresh] }, { channel: "email", content: "hi", now }), false);
  assert.equal(isRecentDuplicate({ communications: [] }, { channel: "sms", content: "hi", now }), false);
});

test("sendUpsellContact: skips an identical recent send (idempotent)", async () => {
  const recent = { source: "resolution-upsell", channel: "sms", body: "hi", happenedAt: new Date().toISOString() };
  const { calls, deps } = makeDeps({ caseProfile: { communications: [recent] } });
  const r = await sendUpsellContact({ domain: "TAG", caseId: 1, channel: "sms", content: "hi" }, deps);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "duplicate-recent-send");
  assert.equal(calls.text.length, 0);
});

// ── bulk: dedup + cap + isolation ─────────────────────────────────────────────
test("sendBulkUpsellContact: dedups, caps the batch, tallies, isolates per-case errors", async () => {
  const { deps } = makeDeps();
  // case 9 throws inside the transport (per-case isolation), but cap=2 keeps only [1,1→1, 2]
  const out = await sendBulkUpsellContact({ domain: "TAG", caseIds: [1, 1, 2, 3], channel: "sms", content: "hi" }, deps);
  assert.equal(out.requested, 4);
  assert.equal(out.cap, 2);
  assert.equal(out.total, 2, "deduped [1,2,3] then capped to 2");
  assert.equal(out.droppedOverCap, 1);
  assert.equal(out.sent, 2);
});
