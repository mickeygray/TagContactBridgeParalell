"use strict";

// ONE call section, both directions.
//
// Mickey 2026-07-31: "the ld calls to hear get mixed into calls to hear. its
// the same email one just only prints LD related stuff" and then "i mean this
// for the entire email basically gotta solve that issue."
//
// Before this there were two sections asking the same question — a CallRail
// list and a separate LD list — so "which call do I play next" had two places
// to look and no shared ordering between them. The `ldrecordings` block is
// gone; `longcalls` carries both halves in one list, longest first.
//
// The thing that makes this delicate is the domain rule. CallRail is ONE TAG
// tenant of inbound mail-response calls, so a WYNN board must never carry
// them — that once handed the lead vendor five recordings of our own mail
// callers. LD dials are per-case and per-domain, so they travel. The filter
// therefore applies to the inbound half ONLY, which is exactly what makes the
// vendor board "the same email, one just only prints LD related stuff".

const test = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

const longcalls = blocks.BY_ID.get("longcalls");

const inboundCall = (over = {}) => ({
  callId: "CAL-1", phone: "5551234567", source: "Urgent Third State",
  durationSec: 1200, dateKey: "2026-07-15", ...over,
});

const ldDial = (over = {}) => ({
  domain: "wynn", caseId: "136599", dateKey: "2026-07-15",
  attempts: [{ durationSeconds: 900, agentId: null, recordingUrl: null, outcome: "done" }],
  ...over,
});

const material = (over = {}) => ({
  callsRange: [], payments: [], callRecordings: {}, callContext: {},
  dials: [], events: [], ldCaseStatus: {}, ldCaseSource: {},
  from: "2026-07-01", to: "2026-07-31", domain: null, ...over,
});

test("inbound and outbound land in ONE list, longest first", () => {
  const rows = longcalls.compute(material({
    callsRange: [inboundCall({ durationSec: 1200 })],   // 20.0
    dials: [ldDial({ attempts: [{ durationSeconds: 3600 }] })], // 60.0
  }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.direction), ["outbound", "inbound"],
    "one ordering across both halves — a reader picks the longest call, not the longest of each kind");
});

test("a vendor board drops CallRail but keeps its LD dials", () => {
  // The whole point of the merge: same section, same code, one board just
  // has nothing inbound to show.
  const rows = longcalls.compute(material({
    domain: "WYNN",
    callsRange: [inboundCall()],
    dials: [ldDial()],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, "outbound");
  assert.equal(rows.some((r) => r.direction === "inbound"), false,
    "a WYNN board must never carry TAG mail-response recordings");
});

test("the TAG board carries both", () => {
  const rows = longcalls.compute(material({
    domain: "TAG",
    callsRange: [inboundCall()],
    dials: [ldDial()],
  }));
  assert.deepEqual(new Set(rows.map((r) => r.direction)), new Set(["inbound", "outbound"]));
});

test("an outbound row names its LD campaign, not a flat LD", () => {
  // Mickey 2026-07-31: "for the Call name you can just say LD Custom in calls
  // worth hearing or the source i suppose." Every outbound row read "LD", so
  // the column answered nothing while the inbound rows named their mail piece.
  const rows = longcalls.compute(material({
    dials: [ldDial()],
    ldCaseSource: { "WYNN:136599": "LD CUSTOM 2" },
  }));
  assert.equal(rows[0].source, "LD CUSTOM 2");
});

test("an unresolvable campaign still reads as LD, never as blank", () => {
  const rows = longcalls.compute(material({ dials: [ldDial()], ldCaseSource: {} }));
  assert.equal(rows[0].source, "LD", "a missing campaign must not cost the row its direction");
});

test("the emailed `call` column is the source for BOTH directions", () => {
  const rows = longcalls.compute(material({
    callsRange: [inboundCall()],
    dials: [ldDial()],
    ldCaseSource: { "WYNN:136599": "LD GENERAL" },
  }));
  const call = longcalls.csv(rows).emailColumns.find((c) => c.header === "call");
  // Longest first, so the 20-minute inbound leads the 15-minute dial.
  assert.deepEqual(rows.map(call.get), ["Urgent Third State", "LD GENERAL"],
    "one rule, so the column reads as 'where did this call come from' either way");
});

test("an outbound row carries the case's CURRENT status as its outcome", () => {
  // Mickey 2026-07-31: "there should be a case status in everyone of thsoe
  // calls like you have for mailer." Reading status-change activity instead
  // answered for only the cases that happened to move inside the window.
  const rows = longcalls.compute(material({
    dials: [ldDial()],
    ldCaseStatus: { "WYNN:136599": "[Bad/Inactive]-DO NOT CALL" },
  }));
  assert.equal(rows[0].outcome, "[Bad/Inactive]-DO NOT CALL");
});

test("the outbound half honours its own, shorter threshold", () => {
  // A 6-minute outbound dial is a long conversation; a 6-minute inbound call
  // is not. LD_LONG_CALL_SECONDS defaults to 300, LONG_CALL_SECONDS to 600.
  const rows = longcalls.compute(material({
    callsRange: [inboundCall({ durationSec: 360 })],
    dials: [ldDial({ attempts: [{ durationSeconds: 360 }] })],
  }));
  assert.deepEqual(rows.map((r) => r.direction), ["outbound"]);
});

test("outbound listen availability uses only the persisted CallLog join", () => {
  const rows = longcalls.compute(material({
    dials: [ldDial({
      attempts: [{
        durationSeconds: 900,
        recordingUrl: "https://daily-dial.example.test/not-authoritative.mp3",
        persistedRecordingUrl: "https://recordings.example.test/persisted.mp3",
      }],
    })],
  }));
  assert.equal(rows[0].listenUrl, "https://recordings.example.test/persisted.mp3");

  const missing = longcalls.compute(material({
    dials: [ldDial({
      attempts: [{
        durationSeconds: 900,
        recordingUrl: "https://daily-dial.example.test/not-authoritative.mp3",
      }],
    })],
  }));
  assert.equal(missing[0].listenUrl, null);
});

test("the lookback tail is dropped — this report is about its own range", () => {
  // callsRange reaches back 45 days so call-to-close lag is not clipped.
  // Measured once: a single-day report listed 319 calls back to 2026-06-15.
  const rows = longcalls.compute(material({
    from: "2026-07-30", to: "2026-07-30",
    callsRange: [inboundCall({ dateKey: "2026-06-20" }), inboundCall({ dateKey: "2026-07-30" })],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateKey, "2026-07-30");
});

test("the LD list is not also its own block any more", () => {
  assert.equal(blocks.BY_ID.has("ldrecordings"), false,
    "two sections answering one question is the thing this merge removed");
  assert.deepEqual(blocks.PRESETS.rollup, blocks.PRESETS["vendor-ld"],
    "same email — the domain, not the block list, is what makes one LD-only");
});
