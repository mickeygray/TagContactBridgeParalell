"use strict";

// The two-implementations guard.
//
// `scripts/ask.js` and the `source` report block answer the same question by
// different routes. Twice this drifted: once the pink piece split across three
// spellings with spend landing on only one of them, and once the ask tool
// skipped attribution entirely and quietly moved a deal per row into Aged.
// Both times the two tools printed confident, different numbers.
//
// These tests pin the SHARED resolvers rather than either caller, because the
// fix was to delete the second copy — and the way that regresses is someone
// re-inlining "just this one bit" back into a caller.

const test = require("node:test");
const assert = require("node:assert/strict");

const ops = require("../../packages/shared-services/src/reportOpsService");
const { AGED_LABEL } = require("../../packages/shared-config/src/activeSources");

const RANGE = { rangeStart: "2026-07-01", rangeEnd: "2026-07-31" };

test("resolveSourceRow folds every spelling of a piece onto one row", () => {
  const aliases = [
    "3rd Day (Pink) Urgent Third State 800-921-9263",
    "3rd Day (Pink) Urgent Third State",
    "Urgent Third Pink State",
  ];
  const rows = aliases.map((sourceAtSale) => ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale,
      caseId: 1,
      caseCreatedDate: "2026-07-10",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: "2026-07-14" },
  ));
  assert.equal(new Set(rows).size, 1, `expected one row, got ${JSON.stringify(rows)}`);
});

test("the mail-house placeholder is a catch-all, not a mail piece", () => {
  const row = ops.resolveSourceRow(
    { domain: "TAG", sourceAtSale: "ABC", caseId: 394513, caseCreatedDate: "2026-07-10" },
    RANGE,
  );
  assert.match(row, /catch-all/, "literal ABC must not masquerade as a piece");
});

test("a payment with no source is unsourced, never zero-attributed to a piece", () => {
  const row = ops.resolveSourceRow({ domain: "TAG", sourceAtSale: null, caseId: 2 }, RANGE);
  assert.equal(row, "(unsourced)");
});

test("an old case on a dead source demotes to Aged", () => {
  // The failure this rule exists to stop: an upsell to a years-old client
  // wearing a live piece's name, which is how BCD once reached 23,125% on $8.
  const row = ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale: "BCD",
      caseId: 3,
      caseCreatedDate: "2023-02-01",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: null },
  );
  assert.equal(row, AGED_LABEL);
});

test("foldSourceKey lands spend on the row the money landed on", () => {
  const moneyRow = ops.resolveSourceRow(
    {
      domain: "TAG",
      sourceAtSale: "3rd Day (Pink) Urgent Third State 800-921-9263",
      caseId: 4,
      caseCreatedDate: "2026-07-10",
      paymentDateKey: "2026-07-15",
    },
    { ...RANGE, attributionCallDate: "2026-07-14" },
  );
  const spendRow = ops.foldSourceKey("3rd Day (Pink) Urgent Third State");
  assert.equal(spendRow, moneyRow, "spend and deals must meet on one row or every cost-per reads —");
});

test("spend on a source nobody runs any more folds to Aged", () => {
  assert.equal(ops.foldSourceKey("Some Retired 2019 Mailer"), AGED_LABEL);
});

test("a deal is a SALE, not a payment row", () => {
  // A first invoice paid in two installments is two initial rows, one deal.
  const rows = [
    { domain: "TAG", caseId: 900, paymentType: "initial", amount: 500 },
    { domain: "TAG", caseId: 900, paymentType: "initial", amount: 500 },
    { domain: "TAG", caseId: 901, paymentType: "initial", amount: 250 },
    { domain: "TAG", caseId: 901, paymentType: "recurring", amount: 100 },
  ];
  const m = ops.measure(rows, ["deals", "newCash", "cash"]);
  assert.equal(m.deals, 2, "two cases sold, regardless of how many rows they paid in");
  assert.equal(m.newCash, 1250, "but every initial dollar still counts");
  assert.equal(m.cash, 1350);
});

test("attributionDateResolver picks the longest call on the closing day", () => {
  const calls = [
    { phone: "5551234567", dateKey: "2026-07-10", durationSec: 900, source: "Urgent Third State" },
    { phone: "5551234567", dateKey: "2026-07-15", durationSec: 120, source: "Urgent Third State" },
    { phone: "5551234567", dateKey: "2026-07-15", durationSec: 800, source: "Urgent Third State" },
  ];
  const resolve = ops.attributionDateResolver(calls);
  const at = resolve({ phone: "555-123-4567", paymentDateKey: "2026-07-15" });
  assert.equal(at, "2026-07-15");
});

test("a servicing call is not evidence that a case was freshly sourced", () => {
  // CallRail also tracks support lines. An existing client ringing in must not
  // keep years-old money attached to a live marketing piece.
  const resolve = ops.attributionDateResolver([
    { phone: "5559876543", dateKey: "2026-07-15", durationSec: 900, source: "Client Contact - TAG" },
  ]);
  assert.equal(resolve({ phone: "5559876543", paymentDateKey: "2026-07-15" }), null);
});

test("a payment with no call evidence resolves to null, not to today", () => {
  const resolve = ops.attributionDateResolver([]);
  assert.equal(resolve({ phone: "5550000000", paymentDateKey: "2026-07-15" }), null);
});

// ── the two things that made the first real email unusable ───────────────
const blocks = require("../../packages/shared-services/src/reportBlocksService");

test("every block carries a ONE-LINE boundary for the email", () => {
  // The full `terms` for `source` ran to 716 characters. Three of those in one
  // email is what Mickey saw as "paragraphs explaining what this is". The full
  // text still ships with the CSV and prints on the console; readers get a line.
  for (const block of blocks.BLOCKS) {
    if (!block.terms) continue;
    assert.ok(block.termsShort, `${block.id} has terms but no termsShort`);
    assert.ok(
      block.termsShort.length <= 140,
      `${block.id} termsShort is ${block.termsShort.length} chars — it is a paragraph again`,
    );
    // A boundary, not a hint: it should still say what the numbers mean.
    assert.ok(block.termsShort.length >= 20, `${block.id} termsShort is too thin to be a boundary`);
  }
});

test("long-call rows can actually resolve a listen link", () => {
  // Every long-call row shipped with no link because callsRange never carried
  // one — CallRail hands recordings out one call at a time, so they arrive as
  // their own bounded gather.
  const longcalls = blocks.BY_ID.get("longcalls");
  assert.ok(longcalls.needs.includes("callRecordings"));
  assert.ok(blocks.SOURCES.includes("callRecordings"));

  const rows = longcalls.compute({
    callsRange: [
      { callId: "CAL-1", phone: "5551234567", source: "Urgent Third State", durationSec: 1200, dateKey: "2026-07-30" },
      { callId: "CAL-2", phone: "5559876543", source: "Affordability Federal", durationSec: 900, dateKey: "2026-07-30" },
    ],
    payments: [],
    callRecordings: { "CAL-1": "https://app.callrail.com/calls/CAL-1/recording/redirect?access_key=x" },
    from: "2026-07-30",
    to: "2026-07-30",
  });
  const byId = new Map(rows.map((r) => [r.minutes, r.listenUrl]));
  assert.match(byId.get(20), /callrail\.com/, "a pooled/fetched link must reach the row");
  // A call with no resolvable recording reads as missing, never as a broken link.
  assert.equal(byId.get(15), null);
});

test("rollup is everything, in Mickey order", () => {
  // "so its top line / per source break down / per agent break down / call
  // links", then "we also need status changes in both emails" and finally
  // "then roll up is everything".
  // Superseded 2026-07-30: "its the same 4 sections for both email just one is
  // filtered", and "work today and call quality are redundant" — `worked` and
  // `ldcalls` were counting the same dials twice, so `worked` came out.
  // `ldrecordings` added 2026-07-31, once PhoneBurner recordings started
  // arriving on the call callback: "identify the person who took the call, the
  // link and the case and bring it to the ld report." It sits beside ldcalls
  // deliberately — that table is one row per PERSON, this one is one row per
  // CALL, and on a WYNN board it is the only call list, because longcalls is
  // CallRail and CallRail is a single TAG tenant.
  assert.deepEqual(blocks.PRESETS.rollup,
    ["topline", "source", "ldcalls", "status", "longcalls"]);
});

test("both boards are the same sections, differing only by filter", () => {
  // Mickey 2026-07-30: "its the same 4 sections for both email just one is
  // filtered." Two shapes to maintain is how they drifted apart in the first
  // place.
  assert.deepEqual(blocks.PRESETS["vendor-ld"], blocks.PRESETS.rollup);
  // Now ONE agent report — "inbound, dials, connected, talk time, deals, cash
  // so one place for calls by agent" — so it draws on the queue and payments
  // too. Still load-bearing: outbound call quality comes from PhoneBurner
  // dials and can never be served by callsRange, which is CallRail, one TAG
  // tenant of INBOUND mail-response calls.
  const needs = blocks.BY_ID.get("ldcalls").needs;
  assert.ok(needs.includes("dials"));
  assert.ok(!needs.includes("callsRange"), "outbound quality must not come from CallRail");
});

test("a tenant-scoped top line drops channels that are not its own", () => {
  // A WYNN vendor board carried TAG mail spend against WYNN revenue and
  // reported net -$2,773 on a day the vendor actually made $250.
  const topline = blocks.BY_ID.get("topline");
  const material = {
    payments: [{ domain: "WYNN", caseId: 9, paymentType: "initial", amount: 250 }],
    spend: { total: 3023.17, mail: 3019.17, ld: 0, mailPieces: 3321, ldLeads: 90 },
    dials: [{ attempts: [{}, {}] }],
    callsBySource: { Pink: { calls: 65, responses: 44 } },
    ldLeads: { total: 86 },
  };
  const wynn = topline.compute({ ...material, domain: "WYNN" });
  assert.equal(wynn.mailApplies, false);
  assert.equal(wynn.mailSpend, 0);
  assert.equal(wynn.mailCalls, 0, "CallRail is a single TAG tenant");
  assert.equal(wynn.net, 250, "net must not be dragged down by another tenant mail spend");
  assert.doesNotMatch(topline.renderText(wynn), /mail response/);

  const tag = topline.compute({ ...material, domain: "TAG" });
  assert.equal(tag.mailApplies, true);
  assert.equal(tag.mailSpend, 3019.17);
  assert.equal(tag.mailCalls, 65);
});

test("key status changes list the cases to chase, money first", () => {
  // "redlines to chase can be status changes broadly and then key status changes"
  const status = blocks.BY_ID.get("status");
  const d = status.compute({ events: [
    { kind: "status-change", domain: "WYNN", caseId: 2, createdBy: "Sean Lucas", payload: { safetyClass: "dnc", toStatus: "[Bad/Inactive]-DO NOT CALL" } },
    { kind: "status-change", domain: "TAG", caseId: 1, createdBy: "Alexander Banks", payload: { safetyClass: "suspended", toStatus: "[Suspended]-PAYMENT DEFAULT STOP WORK" } },
    { kind: "status-change", domain: "TAG", caseId: 1, createdBy: "Alexander Banks", payload: { safetyClass: "suspended", toStatus: "[Suspended]-PAYMENT DEFAULT STOP WORK" } },
    { kind: "status-change", domain: "TAG", caseId: 5, payload: { safetyClass: "postdate", toStatus: "[Active Prospect]-POST DATE" } },
    { kind: "conversion", domain: "TAG", caseId: 7 },
  ] });
  assert.equal(d.dnc, 1);
  assert.equal(d.conversions, 1);
  // The same case re-saved on the same lane is ONE chase, not two.
  assert.equal(d.keyChanges.length, 3);
  assert.deepEqual(d.keyChanges.map((k) => k.lane), ["suspended", "postdate", "dnc"]);
  const text = status.renderText(d);
  assert.match(text, /REDLINES TO CHASE \(3\)/);
  assert.match(text, /SUSPENDED\s+TAG 1/);
});
test("the top line carries no blended ROI", () => {
  // "roi can only apply by source" — a single return across mail and LD averages
  // a piece that pays for itself with one that does not.
  const topline = blocks.BY_ID.get("topline");
  const d = topline.compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000 },
      { domain: "TAG", caseId: 1, paymentType: "recurring", amount: 250 },
    ],
    // The composer OVERWRITES spend.ldLeads with the received count once the
    // receipt log is read, and preserves the spend sheet's own figure as
    // ldSheetLeads. Reading spend.ldLeads for "billed" therefore printed
    // "75 received (75 billed)" on a day the sheet billed nothing at all.
    spend: { total: 500, mail: 400, ld: 100, ldLeads: 80, ldSheetLeads: 90, mailPieces: 3000 },
    dials: [{ attempts: [{}, {}] }],
    callsBySource: { Pink: { calls: 10, responses: 7 } },
    ldLeads: { total: 80, byDomain: { WYNN: 80 } },
  });
  assert.equal(d.deals, 1, "one case, two payments, one sale");
  assert.equal(d.cash, 1250);
  assert.equal(d.net, 750);
  assert.ok(!("roi" in d) && !("roas" in d), "top line must not carry a blended return");
  // LD leads are what the cadence RECEIVED, with the invoiced figure alongside.
  assert.equal(d.ldLeads, 80);
  assert.equal(d.ldLeadsBilled, 90);
  const text = topline.renderText(d);
  assert.match(text, /80 received \(90 billed\)/, "a gap between received and billed must be visible");
});

test("per-source shows spend and its return as one fact", () => {
  // "we can smush spend and net roi into one column"
  const source = blocks.BY_ID.get("source");
  const rows = [
    { source: "Pink", deals: 2, newCash: 1000, totalCash: 4000, spend: 1000, roas: 100, roi: 300, responses: 9, costPer: 111 },
    { source: "(unsourced)", deals: 0, newCash: 0, totalCash: 500, spend: 0, roas: null, roi: null, responses: 0, costPer: null },
  ];
  const text = source.renderText(rows);
  assert.match(text, /SPEND → ROI/);
  assert.match(text, /\$1,000\.00 → 300%/, "spend and return read as one column");
  // Money with no spend behind it has no return to show — and must not print 0%.
  assert.match(text, /no spend/);
  assert.doesNotMatch(text, /\$0\.00 → /);
});
