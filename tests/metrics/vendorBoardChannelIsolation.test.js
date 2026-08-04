"use strict";

// A VENDOR BOARD CARRIES ONLY ITS OWN CHANNEL'S MONEY.
//
// THE TENANT RULE dropped mail/BCD SPEND on a non-mail tenant's board but
// never touched MONEY. The moment BCD money appeared under WYNN — 2026-08-04,
// case 138819, $166.67 — the LD vendor's board read "MONEY IN $166.67 (1 deal)"
// while its own spend line said "(LD only)".
//
// That is worse than disclosing another channel: it CREDITS THE VENDOR WITH A
// SALE THEY DID NOT MAKE, on an email that leaves the company.
//
// Mickey 2026-08-04: "bcd money will be in wynn under the source bcd ... it
// will potentially be in both but probably mostly wynn."

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");
const { isLdSource } = require("../../packages/shared-config/src/activeSources");

const source = () => blocks.BY_ID.get("source");
const topline = () => blocks.BY_ID.get("topline");

const pay = (over = {}) => ({
  domain: "WYNN", caseId: 1, paymentType: "initial", amount: 400,
  isChargeback: false, sourceAtSale: "LD CUSTOM", paymentDateKey: "2026-08-04",
  metricsTreatment: { firstPaidDateKey: "2026-08-04" }, ...over,
});

// Mirrors the gatherMaterial filter: keep LD, keep unresolvable, drop the rest.
const vendorFilter = (payments) => payments.filter((p) => {
  const names = [p.sourceAtSale, p.leadSourceName, p.catchAllLabel];
  if (!names.some(Boolean)) return true;
  return names.filter(Boolean).some((n) => isLdSource(n));
});

const material = (payments, domain) => ({
  domain, payments,
  spend: { total: 63, mail: 0, ld: 63, bcd: 0, mailPieces: 0, ldLeads: 21 },
  spendBySource: {}, callsBySource: {}, callsRange: [], caseContacts: {},
  dials: [], ldLeads: null, events: [], from: "2026-08-04", to: "2026-08-04",
});

test("BCD money is dropped from a vendor board", () => {
  const all = [pay({ caseId: 1, amount: 166.67, sourceAtSale: "BCD" }), pay({ caseId: 2, amount: 400 })];
  const rows = source().compute(material(vendorFilter(all), "WYNN"));
  const names = rows.map((r) => String(r.source));
  assert.equal(names.some((n) => /BCD/i.test(n)), false, "the LD vendor must not see BCD");
  assert.ok(names.some((n) => /^LD/.test(n)));
});

test("the vendor is NOT credited with a sale they did not make", () => {
  // The actual harm: their headline claimed a deal that was BCD's.
  const all = [pay({ caseId: 1, amount: 166.67, sourceAtSale: "BCD" })];
  const d = topline().compute(material(vendorFilter(all), "WYNN"));
  assert.equal(d.deals, 0);
  assert.equal(d.cash, 0);
});

test("EVERY LD variant survives the filter", () => {
  for (const s of ["LD CUSTOM", "LD CUSTOM 2", "LD GENERAL", "ld-posting", "LD"]) {
    assert.equal(vendorFilter([pay({ sourceAtSale: s })]).length, 1, `${s} is the vendor's own money`);
  }
});

test("mail money is dropped too — it is not the LD vendor's either", () => {
  const all = [pay({ caseId: 3, amount: 900, sourceAtSale: "Urgent Third State" })];
  assert.equal(vendorFilter(all).length, 0);
});

test("UNRESOLVABLE money stays — a blank source is not proof it is someone else's", () => {
  // Dropping it would understate the vendor rather than overstate them: still
  // wrong, just in the flattering direction. Keep it and let it show.
  const all = [pay({ sourceAtSale: null, leadSourceName: null, catchAllLabel: null })];
  assert.equal(vendorFilter(all).length, 1);
});

test("the lead source counts, not just sourceAtSale", () => {
  // An LD deal is often named ONLY by its lead source — it never rings a
  // marketing line, so nothing else can identify it.
  const all = [pay({ sourceAtSale: null, leadSourceName: "ld-posting" })];
  assert.equal(vendorFilter(all).length, 1);
});

test("the ALL-COMPANY board keeps everything", () => {
  // Unscoped: scopedTenant is null, so the filter never runs and BCD money
  // still reaches the internal board.
  const all = [pay({ caseId: 1, amount: 166.67, sourceAtSale: "BCD" }), pay({ caseId: 2, amount: 400 })];
  const rows = source().compute(material(all, null));
  assert.ok(rows.some((r) => /BCD/i.test(String(r.source))), "BCD money belongs on the internal board");
});
