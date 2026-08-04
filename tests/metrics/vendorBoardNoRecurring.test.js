"use strict";

// A VENDOR BOARD CARRIES NO RECURRING.
//
// Mickey 2026-08-03: "we dont need total recurring on the vendor".
//
// A vendor board answers one question: what did the leads we bought from you
// produce, against what we paid you. Recurring is instalments from cases sold
// in earlier periods — it moves with our collections cadence, not with their
// lead quality, and crediting it flatters them for work their current leads
// did not do.
//
// This ALSO closed a reconciliation gap that predates the change. On
// 2026-07-31 the WYNN board's top line read $1,525.00 while every row of By
// source summed to $1,100.00 — the $425 of recurring was counted in the
// headline and appeared in no row beneath it.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

const topline = () => blocks.BY_ID.get("topline");

const payment = (over = {}) => ({
  domain: "WYNN", caseId: 1, paymentType: "initial", amount: 1100,
  isChargeback: false, sourceAtSale: "LD CUSTOM", ...over,
});

const material = (domain) => ({
  domain,
  payments: [
    payment({ caseId: 1, amount: 1100, paymentType: "initial" }),
    payment({ caseId: 2, amount: 425, paymentType: "recurring" }),
  ],
  spend: { total: 318, mail: 0, ld: 318, bcd: 0, mailPieces: 0, ldLeads: 106 },
  dials: [], callsBySource: {}, ldLeads: null, events: [],
});

test("a vendor board reports NEW money only", () => {
  const d = topline().compute(material("WYNN"));
  assert.equal(d.vendorBoard, true);
  assert.equal(d.cash, 1100, "recurring must not reach the headline");
  assert.equal(d.recurringExcluded, 425, "and what was set aside is still reported");
});

test("NET moves with it — the board must be explicable from its own numbers", () => {
  // Showing new money on the top line while NET quietly still nets recurring
  // is the "hiding a row hides money" failure, inverted.
  const d = topline().compute(material("WYNN"));
  assert.equal(d.net, 782, "1100 new − 318 spend");
});

test("the vendor headline says WHY, rather than printing a false zero", () => {
  const text = topline().renderText(topline().compute(material("WYNN")));
  assert.match(text, /new business only/);
  assert.equal(/recurring/i.test(text), false, "no recurring clause at all on a vendor board");
});

test("the ALL-COMPANY board is completely unchanged", () => {
  const d = topline().compute(material(null));
  assert.equal(d.vendorBoard, false);
  assert.equal(d.cash, 1525, "unscoped still counts recurring");
  assert.equal(d.recurring, 425);
  assert.equal(d.net, 1207);
  const text = topline().renderText(d);
  assert.match(text, /recurring/, "the internal board still breaks it out");
});

test("the mail tenant's own board is NOT a vendor board", () => {
  // TAG is us. Scoping to it must not strip our own recurring.
  const d = topline().compute(material("TAG"));
  assert.equal(d.vendorBoard, false);
  assert.equal(d.cash, 1525);
});

test("recurring is never silently lost — it is reported as excluded", () => {
  // The whole point: the money is set aside, not deleted. A reader must be
  // able to see that a decision was made.
  const d = topline().compute(material("WYNN"));
  assert.equal(d.recurring, 425, "still on the data");
  assert.equal(d.recurringExcluded, 425);
  assert.equal(d.cash + d.recurringExcluded, 1525, "and it still adds back to the truth");
});
